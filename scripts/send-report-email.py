#!/usr/bin/env python3
"""
Send the tabletop report email via Gmail SMTP (smtplib).

Uses Gmail's standard SMTP with an app password. Reads the report HTML from
a file (or stdin) and sends it to the recipient.

Usage:
  python3 scripts/send-report-email.py <report.html> [subject] [to]

Env overrides:
  SMTP_USER, SMTP_PASS, REPORT_TO
"""
import os
import smtplib
import sys
from email.mime.text import MIMEText
from email.utils import formataddr

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
SMTP_USER = os.environ.get("SMTP_USER", "danoclawnor@gmail.com")
# App password MUST come from the environment — never hardcode credentials.
SMTP_PASS = os.environ.get("SMTP_PASS")
REPORT_TO = os.environ.get("REPORT_TO", "legacyboy@gmail.com")


if not SMTP_PASS:
    print("error: SMTP_PASS env var is required (Gmail app password)", file=sys.stderr)
    sys.exit(2)


def main():
    if len(sys.argv) < 2:
        print("usage: send-report-email.py <report.html> [subject] [to]", file=sys.stderr)
        sys.exit(1)

    html_path = sys.argv[1]
    subject = sys.argv[2] if len(sys.argv) > 2 else "Tabletop Exercise Report"
    to = sys.argv[3] if len(sys.argv) > 3 else REPORT_TO

    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    msg = MIMEText(html, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = formataddr(("Tabletop D20", SMTP_USER))
    msg["To"] = to

    print(f"Sending '{subject}' to {to} via Gmail SMTP...")
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(SMTP_USER, [to], msg.as_string())
    print("Sent OK.")


if __name__ == "__main__":
    main()
