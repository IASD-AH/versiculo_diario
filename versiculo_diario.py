"""Versículo bíblico diário: Telegram (canal) + payload para o WhatsApp.

Escolhe o versículo do dia a partir de dados/versiculos_iasd_ara_5anos.json:
    índice = (dias desde VERSICULOS_DATA_INICIO, no fuso de Lisboa) mod N
Sem estado entre execuções: re-execuções no mesmo dia publicam o mesmo
versículo e o ciclo recomeça sozinho ao fim de N dias.

Publica no canal Telegram e escreve whatsapp_msg.txt, consumido a seguir
pelo send_whatsapp.js (mesmo formato do bot das meditações).

Uso local (sem enviar nada):
    python versiculo_diario.py --dry-run [--data AAAA-MM-DD]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

FICHEIRO_VERSICULOS = Path(__file__).with_name("dados") / "versiculos_iasd_ara_5anos.json"
FICHEIRO_WHATSAPP = Path("whatsapp_msg.txt")
FUSO = ZoneInfo("Europe/Lisbon")
# Dia em que é publicado o 1.º versículo (id 1). Pode ser alterado com a
# variável do repositório VERSICULOS_DATA_INICIO (AAAA-MM-DD).
DATA_INICIO_PADRAO = datetime.date(2026, 11, 28)
MAX_TENTATIVAS = 3
ESPERA_ENTRE_TENTATIVAS_S = 20

DIAS_SEMANA = ["Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira",
               "Sexta-feira", "Sábado", "Domingo"]
MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
         "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]
_MDV2_ESPECIAIS = r"_*[]()~`>#+-=|{}.!\\"


def escapar_mdv2(texto: str) -> str:
    """Escapa texto para o parse_mode MarkdownV2 do Telegram."""
    return "".join("\\" + c if c in _MDV2_ESPECIAIS else c for c in texto)


def carregar_versiculos(caminho: Path) -> list[dict[str, str]]:
    """Lê o JSON e devolve a lista normalizada, ordenada pelo número do dia.

    Aceita o ficheiro completo ({"versiculos": [{id, referencia, texto, tema}]})
    e o formato da amostra ({"dias": [{dia, referencia, versiculo, crenca,
    aplicacao_pratica}]}). Falha com ValueError se algum registo estiver vazio.
    """
    with caminho.open(encoding="utf-8") as f:
        dados = json.load(f)

    if "versiculos" in dados:
        brutos = sorted(dados["versiculos"], key=lambda v: int(v["id"]))
        lista = [{
            "referencia": v.get("referencia", ""),
            "texto": v.get("texto", ""),
            "tema": v.get("tema", ""),
            "aplicacao": "",
        } for v in brutos]
    elif "dias" in dados:
        brutos = sorted(dados["dias"], key=lambda v: int(v["dia"]))
        lista = [{
            "referencia": v.get("referencia", ""),
            "texto": v.get("versiculo", ""),
            "tema": v.get("crenca", ""),
            "aplicacao": v.get("aplicacao_pratica", ""),
        } for v in brutos]
    else:
        raise ValueError("JSON sem a chave 'versiculos' nem 'dias'.")

    if not lista:
        raise ValueError("Lista de versículos vazia.")
    for i, v in enumerate(lista, start=1):
        v = {k: " ".join(str(s).split()) for k, s in v.items()}  # normaliza espaços
        lista[i - 1] = v
        if not v["referencia"] or not v["texto"]:
            raise ValueError(f"Registo n.º {i} sem referência ou texto.")
    return lista


def indice_do_dia(hoje: datetime.date, inicio: datetime.date, total: int) -> int:
    """Índice (0-based) do versículo de 'hoje'. Antes do início usa o 1.º."""
    return max(0, (hoje - inicio).days) % total


def _data_pt(d: datetime.date) -> str:
    return f"{DIAS_SEMANA[d.weekday()]}, {d.day} de {MESES[d.month - 1]}"


def _hashtag(tema: str) -> str:
    return "#" + "_".join(tema.split()) if tema else ""


def formatar_telegram(v: dict[str, str], hoje: datetime.date) -> str:
    linhas = [
        f"📖 *Versículo do dia* — _{escapar_mdv2(_data_pt(hoje))}_",
        "",
        f"*{escapar_mdv2(v['referencia'])} \\(ARA\\)*",
        f"“{escapar_mdv2(v['texto'])}”",
    ]
    if v["aplicacao"]:
        linhas += ["", "💡 " + escapar_mdv2(v["aplicacao"])]
    if v["tema"]:
        linhas += ["", "🏷️ " + escapar_mdv2(_hashtag(v["tema"]))]
    return "\n".join(linhas)


def formatar_whatsapp(v: dict[str, str], hoje: datetime.date) -> str:
    linhas = [
        f"📖 *Versículo do dia* — _{_data_pt(hoje)}_",
        "",
        f"*{v['referencia']} (ARA)*",
        f"“{v['texto']}”",
    ]
    if v["aplicacao"]:
        linhas += ["", "💡 " + v["aplicacao"]]
    if v["tema"]:
        linhas += ["", "🏷️ " + _hashtag(v["tema"])]
    return "\n".join(linhas)


def _url_da_execucao() -> str:
    """Link para os logs desta execução no GitHub Actions (vazio fora do CI)."""
    servidor = os.getenv("GITHUB_SERVER_URL")
    repo = os.getenv("GITHUB_REPOSITORY")
    run_id = os.getenv("GITHUB_RUN_ID")
    return f"{servidor}/{repo}/actions/runs/{run_id}" if servidor and repo and run_id else ""


def _post_telegram(token: str, payload: dict[str, object]) -> tuple[bool, str]:
    """POST sendMessage. Devolve (ok, erro); o erro nunca contém o token."""
    import requests  # import tardio: --dry-run e testes não precisam dele

    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json=payload, timeout=15)
        r.raise_for_status()
        return True, ""
    except requests.exceptions.RequestException as e:
        detalhe = str(e)
        if e.response is not None:
            detalhe += " | " + e.response.text[:500]
        return False, detalhe.replace(token, "***")


def enviar_alerta_admin(assunto: str, corpo: str) -> None:
    """Alerta em texto simples para o chat pessoal do administrador. Nunca lança."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_PERSONAL_CHAT_ID")
    if not token or not chat_id:
        print("AVISO: TELEGRAM_BOT_TOKEN/TELEGRAM_PERSONAL_CHAT_ID não definidos; alerta não enviado: " + assunto)
        return
    texto = f"🚨 {assunto}\n\n{corpo}"
    run_url = _url_da_execucao()
    if run_url:
        texto += "\n\nLogs: " + run_url
    ok, erro = _post_telegram(token, {"chat_id": chat_id, "text": texto[:4000]})
    print("Alerta enviado para o Telegram pessoal." if ok else f"Falha ao enviar o alerta: {erro}")


def _data_inicio() -> datetime.date:
    valor = (os.getenv("VERSICULOS_DATA_INICIO") or "").strip()
    if not valor:
        return DATA_INICIO_PADRAO
    try:
        return datetime.date.fromisoformat(valor)
    except ValueError:
        print(f"AVISO: VERSICULOS_DATA_INICIO inválida ({valor!r}); a usar {DATA_INICIO_PADRAO}.")
        return DATA_INICIO_PADRAO


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="mostra as mensagens sem enviar")
    parser.add_argument("--data", type=datetime.date.fromisoformat,
                        help="simula outro dia (AAAA-MM-DD)")
    args = parser.parse_args(argv)

    hoje = args.data or datetime.datetime.now(FUSO).date()
    inicio = _data_inicio()

    try:
        versiculos = carregar_versiculos(FICHEIRO_VERSICULOS)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as e:
        print(f"ERRO: não foi possível carregar {FICHEIRO_VERSICULOS}: {e}")
        if not args.dry_run:
            enviar_alerta_admin("Falha no bot do versículo diário",
                                f"Não foi possível carregar o ficheiro de versículos: {e}")
        return 1

    i = indice_do_dia(hoje, inicio, len(versiculos))
    v = versiculos[i]
    msg_tg = formatar_telegram(v, hoje)
    msg_wa = formatar_whatsapp(v, hoje)
    print(f"Data (Lisboa): {hoje} | início: {inicio} | versículo {i + 1}/{len(versiculos)}: {v['referencia']}")

    if args.dry_run:
        print("\n--- Telegram (MarkdownV2) ---\n" + msg_tg)
        print("\n--- WhatsApp ---\n" + msg_wa)
        return 0

    # Payload do WhatsApp primeiro: uma falha no Telegram não deve impedir o grupo.
    FICHEIRO_WHATSAPP.write_text(msg_wa + "\n", encoding="utf-8")
    print(f"Payload do WhatsApp escrito em {FICHEIRO_WHATSAPP}.")

    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("ERRO: TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não definidos.")
        enviar_alerta_admin("Falha no bot do versículo diário",
                            "TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não definidos; o Telegram não foi publicado.")
        return 0  # o WhatsApp ainda corre

    ultimo_erro = ""
    payload = {"chat_id": chat_id, "text": msg_tg, "parse_mode": "MarkdownV2",
               "link_preview_options": {"is_disabled": True}}
    for tentativa in range(1, MAX_TENTATIVAS + 1):
        ok, ultimo_erro = _post_telegram(token, payload)
        if ok:
            print("Versículo publicado no Telegram.")
            return 0
        print(f"Falha no envio Telegram (tentativa {tentativa}/{MAX_TENTATIVAS}): {ultimo_erro}")
        if tentativa < MAX_TENTATIVAS:
            time.sleep(ESPERA_ENTRE_TENTATIVAS_S)

    enviar_alerta_admin("Falha no bot do versículo diário",
                        f"Envio de {v['referencia']} para o canal Telegram falhou: {ultimo_erro}")
    return 0  # o alerta já foi enviado; o WhatsApp ainda corre


if __name__ == "__main__":
    sys.exit(main())
