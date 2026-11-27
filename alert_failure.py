import os
import requests

def send_telegram_alert():
    # Bot token (secret TELEGRAM_BOT_TOKEN)
    bot_token = os.getenv('TELEGRAM_BOT_TOKEN')
    # Administrator chat (secret TELEGRAM_PERSONAL_CHAT_ID)
    personal_chat_id = os.getenv('TELEGRAM_PERSONAL_CHAT_ID')

    if not bot_token or not personal_chat_id:
        print("CRITICAL MONITORING ERROR: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_PERSONAL_CHAT_ID variables.")
        return

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    
    run_url = os.getenv('RUN_URL', '')
    # SESSAO_FRESCA=1: o login no WhatsApp funcionou nesta execução (a sessão
    # foi guardada); a falha foi no envio, não na sessão.
    if os.getenv('SESSAO_FRESCA') == '1':
        causa = (
            "O login no WhatsApp funcionou e a sessão foi guardada, "
            "mas a publicação falhou. Não é preciso novo QR Code."
        )
    else:
        causa = (
            "O WhatsApp não autenticou (sessão expirada/revogada ou WhatsApp Web não arrancou).\n"
            "Se recebeu um QR Code neste chat, scaneie-o. Caso contrário, corra o workflow "
            "manualmente com a opção \"pareamento\"."
        )

    alert_text = "🚨 FALHA NO BOT DO VERSÍCULO DIÁRIO 🚨\n\n" + causa
    if run_url:
        alert_text += "\n\nLogs: " + run_url

    # Texto simples (sem parse_mode): o URL e a causa contêm caracteres que
    # o Markdown do Telegram rejeitaria.
    payload = {
        'chat_id': personal_chat_id,
        'text': alert_text,
    }

    try:
        response = requests.post(url, json=payload, timeout=15)
        response.raise_for_status()
        print("Telegram personal failure alert sent successfully.")
    except requests.exceptions.RequestException as e:
        print(f"Failed to send Telegram alert: {e}")

if __name__ == "__main__":
    send_telegram_alert()
