# 📖 Versículo Diário — IASD de Angra do Heroísmo

Publica todos os dias, às **14:00 de Lisboa**, um versículo bíblico (Almeida Revista e Atualizada) no canal do Telegram e no grupo do WhatsApp da igreja. Corre no GitHub Actions, sem servidor próprio.

Os versículos vêm de um plano de 5 anos com 1826 entradas (`dados/versiculos_iasd_ara_5anos.json`). A estrutura e os secrets são os mesmos do bot das meditações ([IASD-AH/meditacao_iasdah](https://github.com/IASD-AH/meditacao_iasdah)).

## 🗂️ Estrutura

| Ficheiro | Função |
| :--- | :--- |
| `versiculo_diario.py` | Escolhe o versículo do dia, publica no Telegram (MarkdownV2) e escreve o payload do WhatsApp (`whatsapp_msg.txt`). Alerta o administrador se falhar. |
| `send_whatsapp.js` | Login no WhatsApp Web (whatsapp-web.js, com tentativas, diagnóstico e QR por Telegram) e envio ao grupo. |
| `session_manager.py` | Gestão da sessão WhatsApp no CI: `restore`, `recuperar`, `health`, `clean`, `compress`, `clear`. |
| `alert_failure.py` | Alerta no Telegram pessoal quando um passo do workflow falha. |
| `.github/workflows/versiculo_diario.yml` | Agendamento, sessão, dependências, publicação, alertas e gravação da sessão. |
| `dados/versiculos_iasd_ara_5anos.json` | Os 1826 versículos (`id`, `referencia`, `texto`, `tema`, …). |
| `tests/` | Testes: `python -m unittest discover -s tests`. |

## 🔧 Como funciona

* **Escolha do versículo:** índice = (dias desde `VERSICULOS_DATA_INICIO`, data de Lisboa) mod 1826. Não guarda estado: re-execuções no mesmo dia repetem o versículo, e o ciclo recomeça sozinho ao fim de 5 anos.
* **Hora:** o cron do GitHub é em UTC e Portugal muda de hora. Há dois crons (13:00 e 14:00 UTC); o job `horario` deixa passar só o que corresponde às 14:00 de Lisboa nesse dia. O GitHub não garante a hora e pode atrasar o arranque.
* **Telegram primeiro, WhatsApp depois:** o payload do WhatsApp é escrito antes do envio para o Telegram, por isso uma falha no Telegram não impede o grupo.
* **Sessão WhatsApp:** guardada como artefacto `whatsapp-session`, cifrada com AES-256 (`WHATSAPP_SESSION_KEY`) e renovada sempre que uma execução autentica. Este repositório tem a **sua própria** sessão (um dispositivo ligado à parte do bot das meditações).

## ⚙️ Configuração

### Secrets (`Settings > Secrets and variables > Actions > Secrets`)

Os mesmos do bot das meditações:

| Secret | Descrição |
| :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Token do bot (`@BotFather`). |
| `TELEGRAM_CHAT_ID` | Canal/grupo do Telegram onde o versículo é publicado. |
| `TELEGRAM_PERSONAL_CHAT_ID` | Chat pessoal do administrador: alertas e QR Code de pareamento. |
| `WHATSAPP_GROUP_ID` | Grupo do WhatsApp (ex.: `1203630XXXXXXXXX@g.us`). |
| `WHATSAPP_SESSION_KEY` | Chave longa e aleatória que cifra a sessão (`openssl rand -base64 48`). |

### Variáveis opcionais (`… > Variables`)

| Variável | Descrição |
| :--- | :--- |
| `VERSICULOS_DATA_INICIO` | Dia em que sai o versículo n.º 1 (`AAAA-MM-DD`). Por omissão `2026-11-28`. |
| `WHATSAPP_WEB_VERSION` | Fixa a versão do WhatsApp Web. Só para emergências. |

## 🔐 Primeiro arranque (pareamento)

1. Defina os secrets.
2. *Actions → Publicar Versículo Diário → Run workflow*, com **pareamento** ativo.
3. Leia, no WhatsApp do telemóvel (*Dispositivos ligados*), o QR Code que chega ao seu chat pessoal do Telegram.
4. A sessão fica guardada. A partir daí, o envio diário é automático.

## 💻 Execução local

```bash
python versiculo_diario.py --dry-run                 # versículo de hoje, sem enviar
python versiculo_diario.py --dry-run --data 2027-03-01
python -m unittest discover -s tests
```
