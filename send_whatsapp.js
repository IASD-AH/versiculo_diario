const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const https = require('https');
const QRCode = require('qrcode');

// Flag de encerramento controlado: quando true, o handler 'disconnected'
// não deve interpretar o fecho intencional (client.destroy()) como falha.
let finalizando = false;

// Marker de sessão autenticada: escrito quando o evento 'ready' dispara.
// O workflow usa-o para decidir se a sessão deve ser guardada no
// artefacto — garante que a sessão fresca é persistida sempre que a
// autenticação teve sucesso, mesmo que o envio falhe depois (sem isto,
// a sessão era descartada e caducava a cada ~2 dias).
const AUTH_MARKER = './whatsapp_auth/.autenticado';
const READY_MARKER = './whatsapp_auth/.ready';
const INVALID_MARKER = './whatsapp_auth/.invalido';

// Marker FORA de whatsapp_auth (logo, nunca entra no tarball): só existe se
// ESTA execução autenticou. O .autenticado vem dentro do artefacto restaurado
// e por isso não distingue uma sessão fresca de uma sessão antiga — o
// workflow usa o .session_fresh para decidir se guarda a sessão.
const FRESH_MARKER = './.session_fresh';

// ------------------------------------------------------------
// REDE DE SEGURANÇA GLOBAL
// ------------------------------------------------------------
// O WhatsApp Web recarrega a SPA logo após o login; o puppeteer rejeita
// promessas internas da biblioteca (sem catch) com "Execution context was
// destroyed" — no Node 22 isso matava o processo a meio do arranque
// (runs de 2026-10-21 e 2026-10-25). Estes erros de navegação são
// transitórios: registamos e deixamos o watchdog/retry decidir.
const ERROS_NAVEGACAO = /Execution context was destroyed|Target closed|Session closed|detached Frame/i;

// Quando o WhatsApp Web navega/recarrega, a biblioteca re-injeta-se fora do
// initialize(); se essa re-injeção esgota o authTimeoutMs, o erro chega aqui
// como rejeição sem tratamento ("auth timeout" / "Waiting failed"). Em vez
// de esperar mais ~2 min pelo watchdog, a tentativa em curso termina já.
const ERROS_INJECAO = /auth timeout|Waiting failed/i;
let abortarTentativaAtual = null;

process.on('unhandledRejection', (reason) => {
    const msg = (reason && reason.message) || String(reason);
    if (ERROS_INJECAO.test(msg) && abortarTentativaAtual) {
        console.error('Re-injeção do WhatsApp Web falhou:', msg, '— a terminar a tentativa já.');
        abortarTentativaAtual('inject_timeout');
        return;
    }
    console.error('Aviso: promessa rejeitada sem tratamento (ignorada):', msg);
});

process.on('uncaughtException', (err) => {
    const msg = (err && err.message) || String(err);
    if (ERROS_NAVEGACAO.test(msg)) {
        console.error('Aviso: erro de navegação do WhatsApp Web (ignorado):', msg);
        return;
    }
    console.error('Erro fatal não tratado:', (err && err.stack) || msg);
    process.exit(1);
});

function marcarSessaoAutenticada() {

    try {

        fs.mkdirSync('./whatsapp_auth', {
            recursive: true
        });

        fs.writeFileSync(
            AUTH_MARKER,
            String(Date.now())
        );

        fs.writeFileSync(FRESH_MARKER, new Date().toISOString());

        fs.writeFileSync(
            READY_MARKER,
            JSON.stringify(
                {
                    state: 'READY',
                    timestamp: new Date().toISOString()
                },
                null,
                2
            )
        );


        if (fs.existsSync(INVALID_MARKER)) {
            fs.unlinkSync(INVALID_MARKER);
        }

    } catch (err) {

        console.error(
            'Aviso: não foi possível escrever os marcadores da sessão:',
            err.message || err
        );
    }
}

function marcarSessaoInvalida(reason) {

    try {

        fs.mkdirSync('./whatsapp_auth', {
            recursive: true
        });

        if (fs.existsSync(AUTH_MARKER)) {
            fs.unlinkSync(AUTH_MARKER);
        }

        if (fs.existsSync(READY_MARKER)) {
            fs.unlinkSync(READY_MARKER);
        }

        // Sessão revogada: não deve ser guardada por cima do último artefacto.
        if (fs.existsSync(FRESH_MARKER)) {
            fs.unlinkSync(FRESH_MARKER);
        }

        fs.writeFileSync(
            INVALID_MARKER,
            JSON.stringify(
                {
                    state: 'INVALID',
                    timestamp: new Date().toISOString(),
                    reason
                },
                null,
                2
            )
        );

    } catch (err) {

        console.error(
            'Aviso: não foi possível marcar a sessão como inválida:',
            err.message || err
        );
    }
}

// ------------------------------------------------------------
// MODO DE PAREAMENTO (testes / recuperação de sessão)
// ------------------------------------------------------------
// Ativar com: WHATSAPP_PAREAMENTO=1 node send_whatsapp.js
// Executa APENAS a autenticação: desenha o QR Code no terminal para
// associar um novo dispositivo e, depois de lido, persiste a sessão
// em ./whatsapp_auth e sai com sucesso. NÃO exige whatsapp_msg.txt
// nem WHATSAPP_GROUP_ID — útil quando o artefacto whatsapp-session
// se perdeu e é preciso religar o bot ao WhatsApp.
const MODO_PAREAMENTO = process.env.WHATSAPP_PAREAMENTO === '1';

// ------------------------------------------------------------
// ENVIO DE QR CODE PARA O TELEGRAM (visualização no telemóvel)
// ------------------------------------------------------------
// Quando o WhatsApp gera um QR Code (pareamento ou sessão expirada),
// o texto ASCII do terminal não cabe no ecrã do telemóvel ao ver os
// logs do GitHub Actions. Esta função gera o QR como imagem PNG e
// envia via Bot API para o chat do Telegram, para que possa ser
// escaneado diretamente de uma foto.
// O QR vai SÓ para o chat pessoal do administrador: publicá-lo no canal
// do versículo permitiria a qualquer membro scanear e ligar a SUA conta
// ao bot.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_PERSONAL_CHAT_ID;

function enviarQrParaTelegram(qrDataUrl) {
    return new Promise((resolve) => {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            console.log('ℹ️  TELEGRAM_BOT_TOKEN/TELEGRAM_PERSONAL_CHAT_ID não definidos; QR Code não enviado para o Telegram.');
            resolve();
            return;
        }

        // Extrair dados base64 do data URL (formato: data:image/png;base64,....)
        const match = qrDataUrl.match(/^data:image\/png;base64,(.*)$/);
        if (!match) {
            console.error('⚠️  Não foi possível extrair dados base64 do QR Code.');
            resolve();
            return;
        }

        // O ficheiro tem de seguir em BYTES PNG, não em texto base64: com
        // base64 o Telegram respondia "IMAGE_PROCESS_FAILED" e o QR nunca
        // chegava ao telemóvel, impossibilitando o re-pareamento.
        const body = construirMultipartFoto(
            TELEGRAM_CHAT_ID,
            Buffer.from(match[1], 'base64'),
            'qr_code.png',
            'WhatsApp: Definições > Dispositivos ligados > Ligar um dispositivo. Válido ~60s; novos QR seguem automaticamente.'
        );
        const boundary = body.boundary;

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.buffer.length
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok) {
                        console.log('✅ QR Code enviado para o Telegram (imagem).');
                    } else {
                        console.error('⚠️  Telegram rejeitou o envio do QR Code:', json.description || data);
                    }
                } catch (e) {
                    console.error('⚠️  Resposta inesperada do Telegram ao enviar QR Code:', data);
                }
                resolve();
            });
        });

        req.on('error', (err) => {
            console.error('⚠️  Falha ao enviar QR Code para o Telegram:', err.message || err);
            resolve();
        });

        req.write(body.buffer);
        req.end();
    });
}

// Corpo multipart/form-data para sendPhoto: campos de texto + 1 ficheiro
// binário. Devolve { buffer, boundary }.
function construirMultipartFoto(chatId, pngBytes, filename, caption) {
    const boundary = '----TelegramQrBoundary' + Date.now();
    const campo = (nome, valor) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${nome}"\r\n\r\n${valor}\r\n`;

    const cabecalho =
        campo('chat_id', chatId) +
        (caption ? campo('caption', caption) : '') +
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
        'Content-Type: image/png\r\n\r\n';

    return {
        boundary,
        buffer: Buffer.concat([
            Buffer.from(cabecalho, 'utf8'),
            pngBytes,
            Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
        ])
    };
}

// Pin opcional da versão do WhatsApp Web. Por omissão NÃO há pin: o pin
// fixo 2.3000.1046922887-alpha expirou a 2026-11-06 e foi removido do
// catálogo wppconnect, deixando o boot suspenso sem 'qr' nem 'ready' (todas
// as execuções desde então). Para fixar uma versão em caso de emergência,
// definir WHATSAPP_WEB_VERSION (ex.: 2.3000.1056346120-alpha) com a versão
// "current" de https://wppconnect.io/whatsapp-versions.
const VERSAO_WEB_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-alpha|-beta)?$/;

function configVersaoWeb(versaoForcada) {
    const versao = (versaoForcada || process.env.WHATSAPP_WEB_VERSION || '').trim();
    if (!VERSAO_WEB_RE.test(versao)) {
        return { webVersionCache: { type: 'none' } };
    }
    console.log(`A usar WhatsApp Web fixado em ${versao}.`);
    return {
        webVersion: versao,
        webVersionCache: {
            type: 'remote',
            remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${versao}.html`
        }
    };
}

// Versão "current" publicada pelo catálogo wppconnect (o mesmo que o pin
// manual usa). Devolve null se não for possível obtê-la — nunca lança.
async function obterVersaoWebAtual() {
    const url = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json';
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            console.error(`Catálogo de versões indisponível (HTTP ${res.status}).`);
            return null;
        }
        const versao = String((await res.json()).currentVersion || '').trim();
        if (!VERSAO_WEB_RE.test(versao)) {
            console.error('Catálogo de versões devolveu um valor inválido:', versao.slice(0, 40));
            return null;
        }
        return versao;
    } catch (err) {
        console.error('Falha ao obter a versão atual do WhatsApp Web:', err.message || err);
        return null;
    }
}

function criarCliente(versaoForcada) {
    return new Client({
        ...configVersaoWeb(versaoForcada),
        authStrategy: new LocalAuth({
            dataPath: './whatsapp_auth'
        }),
        // A biblioteca dá apenas authTimeoutMs (30s por omissão) para o
        // bundle do WhatsApp Web carregar e para o socket sair de
        // OPENING/PAIRING. Com um perfil restaurado de ~55 MB num runner frio
        // isso não chega: "auth timeout" / "Waiting failed: 30000ms
        // exceeded" (run de 2026-11-26 17:10 UTC).
        authTimeoutMs: 120000,
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            // protocolTimeout aumentado para 3 minutos (2026-09-07): previne
            // "Runtime.callFunctionOn timed out" no CI do GitHub Actions, onde
            // o browser fica mais lento após atualização do WhatsApp Web em
            // julho de 2026. O valor default (60s) é insuficiente para operações
            // do WhatsApp Web neste ambiente.
            protocolTimeout: 180000
        }
    });
}

// ------------------------------------------------------------
// LIBERTAR O PERFIL DO CHROMIUM ENTRE TENTATIVAS
// ------------------------------------------------------------
// client.destroy() numa tentativa que não chegou a 'ready' nem sempre fecha
// o Chromium; o processo vivo mantém o SingletonLock e as tentativas
// seguintes falham de imediato com "The browser is already running for
// .../whatsapp_auth/session" (runs de 2026-11-25 e 2026-11-26).
const SINGLETONS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

async function libertarCliente(client) {
    try {
        await Promise.race([
            client.destroy(),
            new Promise((resolve) => setTimeout(resolve, 15000))
        ]);
    } catch (err) {
        console.error('Aviso: erro durante client.destroy() (não-fatal):', err.message || err);
    }

    try {
        const proc = client.pupBrowser && client.pupBrowser.process();
        if (proc && proc.exitCode === null && !proc.killed) {
            proc.kill('SIGKILL');
            console.error('Chromium da tentativa anterior terminado à força.');
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    } catch (err) {
        console.error('Aviso: não foi possível terminar o Chromium:', err.message || err);
    }

    for (const nome of SINGLETONS) {
        try {
            fs.rmSync(`./whatsapp_auth/session/${nome}`, { force: true });
        } catch (err) {
            console.error(`Aviso: não foi possível remover ${nome}:`, err.message || err);
        }
    }
}

// ------------------------------------------------------------
// AUTENTICAÇÃO COM RETRY (fábrica de clientes)
// ------------------------------------------------------------
// Cada tentativa cria um Cliente NOVO: re-utilizar a mesma instância
// depois de um destroy() deixa referências a páginas mortas do browser
// e crasha a reinicialização com "Target closed" (falha do run de
// 2026-09-06). O watchdog de 90s fecha cada tentativa; falhas
// transitórias de rede/boot são absorvidas sem gastar o run inteiro.
// ------------------------------------------------------------
// CACHE DA APLICAÇÃO WEB NO PERFIL RESTAURADO
// ------------------------------------------------------------
// O perfil guardado inclui a cópia da app WhatsApp Web servida pelo Service
// Worker. Quando o WhatsApp publica versões novas (várias por dia em
// novembro/2026), essa cópia antiga arranca, deteta que está desatualizada e
// recarrega — e a re-injeção da biblioteca esgota o tempo (run de 2026-11-27).
// O login vive em IndexedDB/Local Storage, que NÃO são tocados aqui.
const CACHES_WEB_APP = [
    'Service Worker',
    'Cache',
    'Code Cache',
    'GPUCache'
];

function limparCacheWebApp() {
    for (const nome of CACHES_WEB_APP) {
        const caminho = `./whatsapp_auth/session/Default/${nome}`;
        try {
            if (fs.existsSync(caminho)) {
                fs.rmSync(caminho, { recursive: true, force: true });
                console.log(`Cache da app web removida: ${nome}`);
            }
        } catch (err) {
            console.error(`Aviso: não foi possível remover ${nome}:`, err.message || err);
        }
    }
}

// ------------------------------------------------------------
// DIAGNÓSTICO DA PÁGINA NUMA TENTATIVA FALHADA
// ------------------------------------------------------------
// Só texto e só factos estruturais (rota, título, versão, presença de
// elementos conhecidos). NUNCA conteúdo de conversas nem capturas de ecrã:
// os logs deste repositório são públicos.
async function diagnosticarPagina(client) {
    const page = client.pupPage;
    if (!page || page.isClosed()) {
        console.error('Diagnóstico: página indisponível (browser não arrancou ou já fechou).');
        return;
    }
    try {
        const info = await Promise.race([
            page.evaluate(() => {
                const texto = (document.body && document.body.innerText) || '';
                const temTexto = (re) => re.test(texto);
                const naListaDeConversas = !!document.querySelector('#pane-side');
                return {
                    rota: location.pathname,
                    titulo: document.title,
                    versaoWeb: (window.Debug && window.Debug.VERSION) || null,
                    requireDisponivel: typeof window.require === 'function',
                    qrVisivel: !!document.querySelector('[data-ref], canvas[aria-label]'),
                    listaDeConversas: naListaDeConversas,
                    ecraContinuarWeb: temTexto(/Continue to WhatsApp Web|Continuar para o WhatsApp Web|Usar o WhatsApp Web/i),
                    ecraAtualizar: temTexto(/update|atualiz|actualiz/i) && !naListaDeConversas,
                    ecraCarregamento: !!document.querySelector('progress, [role="progressbar"]'),
                    // Rótulos de botões só fora da lista de conversas (sem dados pessoais).
                    botoes: naListaDeConversas ? [] : Array.from(document.querySelectorAll('button, [role="button"]'))
                        .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40))
                        .filter(Boolean)
                        .slice(0, 6)
                };
            }),
            new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout de 10s')), 10000))
        ]);
        console.error('Diagnóstico da página:', JSON.stringify(info));
    } catch (err) {
        console.error('Diagnóstico da página falhou:', err.message || err);
    }
}

const MAX_TENTATIVAS_INIT = 3;
// 90s era curto para restaurar um perfil de ~55 MB (IndexedDB ~24 MB) num
// runner partilhado. O watchdog é reiniciado a cada sinal de progresso
// ('loading_screen', 'authenticated'), por isso só dispara num boot parado.
const TEMPO_WATCHDOG_INIT = 260000; // > 2 x authTimeoutMs (bundle + socket)

function autenticar() {
    return new Promise((resolveCliente) => {
        (async () => {
            for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_INIT; tentativa++) {
                // Última tentativa sem pin manual: fixa a versão "current" do
                // catálogo (o contorno recomendado upstream quando o WhatsApp
                // serve uma build que a biblioteca ainda não suporta).
                let versaoForcada = null;
                if (tentativa === MAX_TENTATIVAS_INIT && !VERSAO_WEB_RE.test((process.env.WHATSAPP_WEB_VERSION || '').trim())) {
                    versaoForcada = await obterVersaoWebAtual();
                    if (versaoForcada) {
                        console.log(`Última tentativa: a fixar automaticamente o WhatsApp Web na versão atual ${versaoForcada}.`);
                    }
                }
                const client = criarCliente(versaoForcada);
                let autenticado = false;
                let qrTimeout = null;

                // Limpa o timer do QR de tentativas anteriores. Sem isto, o
                // setTimeout(300000) com process.exit(1) de uma tentativa
                // fracassada sobrevive ao client.destroy() e MATA o processo
                // à mesma 5 minutos depois — mesmo que uma tentativa seguinte
                // já tenha autenticado e esteja a meio do envio.
                const limparQrTimeout = () => {
                    if (qrTimeout) {
                        clearTimeout(qrTimeout);
                        qrTimeout = null;
                    }
                };

                const resultado = await new Promise((resolve) => {
                    let watchdog = setTimeout(() => resolve('timeout'), TEMPO_WATCHDOG_INIT);
                    const rearmarWatchdog = () => {
                        clearTimeout(watchdog);
                        watchdog = setTimeout(() => resolve('timeout'), TEMPO_WATCHDOG_INIT);
                    };
                    abortarTentativaAtual = (motivo) => {
                        clearTimeout(watchdog);
                        resolve(motivo);
                    };

                    client.on('loading_screen', (percent, message) => {
                        console.log(`A carregar WhatsApp Web: ${percent}% ${message || ''}`);
                        rearmarWatchdog();
                    });

                    client.on('authenticated', () => {
                        console.log('Sessão aceite pelo WhatsApp (authenticated); a aguardar ready...');
                        rearmarWatchdog();
                    });

                    client.on('qr', async (qr) => {
                        clearTimeout(watchdog);
                        if (qrTimeout) clearTimeout(qrTimeout); // não acumular timers se o 'qr' refrescar
                        if (MODO_PAREAMENTO) {
                            console.error('Modo de pareamento: novo QR Code gerado.');
                            console.error('Abre o WhatsApp no telemóvel (Definições > Dispositivos ligados > Ligar um dispositivo) e aponta a câmara para o QR abaixo.');
                        } else {
                            console.error('AVISO: Sessão expirou. Novo QR Code gerado.');
                        }
                        require('qrcode-terminal').generate(qr, { small: true, inverse: true });

                        // Gerar QR Code como imagem PNG e enviar para o Telegram
                        // (não bloqueia o fluxo: se falhar, o QR ainda está no terminal).
                        try {
                            const qrDataUrl = await QRCode.toDataURL(qr, { type: 'png', scale: 8 });
                            console.log('📷 A enviar QR Code como imagem para o Telegram...');
                            await enviarQrParaTelegram(qrDataUrl);
                        } catch (err) {
                            console.error('⚠️  Falha ao gerar/enviar QR Code para o Telegram:', err.message || err);
                        }

                        // Janela realista para abrir o log + WhatsApp no telemóvel
                        // e scanear (5 minutos, cobrindo o lag de streaming do log).
                        qrTimeout = setTimeout(() => {
                            console.error('Abort: QR Code não foi lido a tempo.');
                            process.exit(1);
                        }, 300000);
                    });

                    client.on('ready', () => {
                        clearTimeout(watchdog);
                        limparQrTimeout();
                        autenticado = true;
                        marcarSessaoAutenticada();
                        resolve('ready');
                    });

                    client.on('auth_failure', (msg) => {

			clearTimeout(watchdog);

  			console.error(
			    'Falha na assinatura de autenticação:',
		            msg
			);

			marcarSessaoInvalida(msg);

			resolve('auth_failure');
		    });


                    client.on('disconnected', (reason) => {
                        if (finalizando) {
                            console.log('Desconexão esperada: encerramento controlado do cliente.');
                            return;
                        }
                        if (autenticado) {

   			   console.error(
  				'Sessão desconectada pelo WhatsApp:',
				reason
    			   );

			   marcarSessaoInvalida(reason);

			   process.exit(1);
                        }
                        clearTimeout(watchdog);
                        resolve('disconnected');
                    });

                    // SEMPRE com catch: uma rejeição não pode crashar o
                    // processo (unhandled rejections são fatais no Node 22).
                    client.initialize().catch((err) => {
                        clearTimeout(watchdog);
                        console.error('Erro durante client.initialize():', err.message || err);
                        resolve('init_error');
                    });
                });

                abortarTentativaAtual = null;

                if (resultado === 'ready') {
                    console.log(`✅ WhatsApp autenticado (tentativa ${tentativa}/${MAX_TENTATIVAS_INIT}).`);
                    resolveCliente(client);
                    return;
                }

                // Cancelar o timer do QR ANTES de destruir o cliente: caso
                // contrário dispara process.exit(1) durante a próxima tentativa.
                limparQrTimeout();
                console.error(`Tentativa ${tentativa}/${MAX_TENTATIVAS_INIT} falhou (${resultado}). A destruir o cliente e a tentar de novo...`);
                await diagnosticarPagina(client);
                finalizando = true; // o destroy() não é uma desconexão real
                await libertarCliente(client);
                finalizando = false;

                // auth_failure = credenciais revogadas: repetir com o mesmo
                // perfil só gasta tempo. Sai para o alerta pedir pareamento.
                if (resultado === 'auth_failure') {
                    break;
                }
            }

            console.error('Abort: autenticação no WhatsApp falhou. Se nenhum QR foi gerado, tentar o pin WHATSAPP_WEB_VERSION (ver criarCliente); se a sessão foi revogada, correr o workflow com "pareamento" e scanear o QR enviado para o Telegram pessoal.');
            process.exit(1);
        })();
    });
}

async function executarEnvio(client) {

    // ------------------------------------------------------------
    // MODO DE PAREAMENTO: autenticar, guardar a sessão e sair.
    // ------------------------------------------------------------
    // Não lê payload, não envia mensagens, não precisa do grupo.
    // A espera de 15s dá tempo ao LocalAuth sincronizar o estado da
    // sessão para ./whatsapp_auth antes do destroy().
    if (MODO_PAREAMENTO) {
        console.log('✅ Autenticado com sucesso — sessão nova válida.');
        console.log('A aguardar 15 segundos para o LocalAuth persistir a sessão em ./whatsapp_auth ...');
        await new Promise(resolve => setTimeout(resolve, 15000));

        finalizando = true;
        try {
            await Promise.race([
                client.destroy(),
                new Promise(resolve => setTimeout(() => {
                    console.error('Aviso: client.destroy() demorou mais de 15s; a forçar a saída.');
                    resolve();
                }, 15000))
            ]);
            console.log('Sessão guardada em ./whatsapp_auth. Pareamento concluído com sucesso.');
        } catch (err) {
            console.error('Aviso: erro durante client.destroy() (não-fatal):', err.message || err);
        }
        process.exit(0);
    }

    console.log('A aguardar 20 segundos para estabilização inicial e sincronização de chats...');
    await new Promise(resolve => setTimeout(resolve, 20000));
    
    if (!fs.existsSync('whatsapp_msg.txt')) {
        console.error('Abort: whatsapp_msg.txt not found.');
        client.destroy();
        process.exit(1);
    }

    const rawContent = fs.readFileSync('whatsapp_msg.txt', 'utf8');
    
    const mensagens = rawContent.split('===DIVISAO_MEDITACAO===')
                                .map(msg => msg.trim())
                                .filter(msg => msg.length > 0);

    if (mensagens.length === 0) {
        console.error('Abort: payload vazio (whatsapp_msg.txt sem mensagens).');
        client.destroy();
        process.exit(1);
    }

    let groupId = process.env.WHATSAPP_GROUP_ID;
    if (!groupId) {
        console.error('Abort: WHATSAPP_GROUP_ID is missing.');
        client.destroy();
        process.exit(1);
    }
    groupId = groupId.trim().replace(/['"]/g, ''); 

    try {
        console.log(`Grupo alvo: ${groupId}`);
        // NOTE: intentionally NOT calling client.getChatById() here.
        // whatsapp-web.js currently has an active, unresolved bug where
        // getChatById crashes with a terse "r" error on the current
        // WhatsApp Web rollout (upstream issue #201838, still open as of
        // this writing) — it hydrates a full Chat model via a heavier
        // internal path that's breaking for many people right now.
        // client.sendMessage() takes a chat ID directly and uses a
        // lighter internal lookup that avoids that code path entirely.

        // Send each message independently: one failing (thrown OR
        // silently swallowed by WhatsApp) shouldn't block the others,
        // and we want a clear per-message pass/fail report instead of
        // a silent drop leaving zero trace in the log.
        const resultados = [];

        for (let i = 0; i < mensagens.length; i++) {
            const numero = i + 1;
            console.log(`\nA processar publicação ${numero} de ${mensagens.length}...`);

            // Clean markdown escapes. Covers the FULL Telegram MarkdownV2
            // escape set (_*[]()~`>#+-=|{}.!) as a safety net — the real
            // fix is that versiculo_diario.py writes the already-clean
            // WhatsApp text instead of the escaped Telegram text,
            // but this stays defensive in case that ever regresses.
            let mensagemLimpa = mensagens[i].replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');

            let enviado = false;
            let ultimoErro = null;

            for (let tentativa = 1; tentativa <= 3 && !enviado; tentativa++) {
                try {
                    await client.sendMessage(groupId, mensagemLimpa);
                    enviado = true;
                    console.log(`Mensagem ${numero} enviada (tentativa ${tentativa}) — chamada resolvida sem erro.`);
                } catch (err) {
                    ultimoErro = err.message || String(err);
                    console.error(`Falha ao enviar mensagem ${numero} (tentativa ${tentativa}):`, ultimoErro);
                    if (tentativa < 3) {
                        console.log('A aguardar antes de tentar novamente...');
                        console.log('A aguardar 15 segundos antes de tentar novamente...');
                        await new Promise(resolve => setTimeout(resolve, 15000));
                    }
                }
            }

            resultados.push({ numero, enviado, erro: ultimoErro });

            if (i < mensagens.length - 1) {
                console.log('⏱️ Aguarda 20 segundos antes da próxima publicação...');
                await new Promise(resolve => setTimeout(resolve, 20000));
            }
        }

        console.log('\n--- Resumo do envio ---');
        resultados.forEach(r => {
            console.log(r.enviado
                ? `✅ Mensagem ${r.numero}: enviada (sem erro reportado)`
                : `❌ Mensagem ${r.numero}: FALHOU — ${r.erro}`);
        });
        console.log('NOTA: "enviada" só confirma que a chamada não lançou erro — se o');
        console.log('WhatsApp descartar a mensagem silenciosamente (bug conhecido da');
        console.log('biblioteca em grupos após a atualização de julho/2026), aqui vai');
        console.log('aparecer como sucesso mesmo assim. Confirma sempre no grupo.');

        const houveFalha = resultados.some(r => !r.enviado);

        // Período de entrega: sendMessage() resolve quando a mensagem é aceite
        // pela camada interna, mas a entrega ao grupo precisa da ligação viva
        // mais alguns segundos; um destroy() imediato perdia a última mensagem.
        console.log('\n⏱️ Aguarda 20 segundos para a entrega antes de encerrar...');
        await new Promise(resolve => setTimeout(resolve, 20000));

        // ------------------------------------------------------------
        // ENCERRAMENTO CONTROLADO
        // ------------------------------------------------------------
        // Espera de 5s para o
        // LocalAuth sincronizar o estado da sessão em disco, seguido de um
        // destroy() efetivamente aguardado (com teto de 15s para o caso do
        // Puppeteer congelar no teardown e suspender o job até ao timeout).
        finalizando = true;
        console.log('\nA aguardar 5 segundos antes de encerrar o cliente...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        try {
            await Promise.race([
                client.destroy(),
                new Promise(resolve => setTimeout(() => {
                    console.error('Aviso: client.destroy() demorou mais de 15s; a forçar a saída.');
                    resolve();
                }, 15000))
            ]);
            console.log('Cliente WhatsApp encerrado corretamente.');
        } catch (err) {
            console.error('Aviso: erro durante client.destroy() (não-fatal):', err.message || err);
        }
        process.exit(houveFalha ? 1 : 0);

    } catch (err) {
        console.error('Erro fatal no processamento:', err.message || err);
        finalizando = true;
        client.destroy();
        process.exit(1);
    }
}

// ------------------------------------------------------------
// ARRANQUE
// ------------------------------------------------------------
// Autentica (com retries e clientes frescos por tentativa) e só depois
// corre o pipeline de envio. O esgotamento das tentativas de autenticação
// faz exit(1) dentro de autenticar(); este catch cobre o resto.
// Pareamento = ligar um dispositivo NOVO. Com o perfil antigo presente o
// WhatsApp Web tenta retomá-lo e nunca mostra o QR. O perfil antigo é
// posto de lado (não apagado): se o QR não for lido, nada é guardado e o
// último artefacto continua intacto.
function prepararPerfilLimpo() {
    if (!fs.existsSync('./whatsapp_auth')) {
        return;
    }
    const destino = `./whatsapp_auth_antigo_${Date.now()}`;
    fs.renameSync('./whatsapp_auth', destino);
    console.log(`Modo de pareamento: perfil anterior movido para ${destino}; a gerar QR com perfil limpo.`);
}

(async () => {
    try {
        if (MODO_PAREAMENTO) {
            prepararPerfilLimpo();
        } else {
            limparCacheWebApp();
        }
        const client = await autenticar();
        await executarEnvio(client);
    } catch (err) {
        console.error('Erro fatal no arranque:', err.message || err);
        finalizando = true;
        process.exit(1);
    }
})();
