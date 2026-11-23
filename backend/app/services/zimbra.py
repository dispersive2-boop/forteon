"""Zimbra user SOAP and attachment upload over an explicitly configured HTTPS origin."""
from __future__ import annotations

import json
from email.headerregistry import Address
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import parseaddr
from pathlib import Path
from xml.etree import ElementTree as ET

import httpx

SOAP = "http://www.w3.org/2003/05/soap-envelope"
ACCOUNT = "urn:zimbraAccount"
MAIL = "urn:zimbraMail"
CONTEXT = "urn:zimbra"


class MailError(Exception):
    pass


def child(parent: ET.Element, ns: str, tag: str, value: str | None = None, **attrs: str) -> ET.Element:
    element = ET.SubElement(parent, f"{{{ns}}}{tag}", attrs)
    element.text = value
    return element


class Zimbra:
    def __init__(self, client: httpx.Client, origin: str):
        self.client = client
        self.origin = origin
        self.token: str | None = None
        self.address: str | None = None

    def call(self, request: ET.Element) -> ET.Element:
        envelope = ET.Element(f"{{{SOAP}}}Envelope")
        if self.token:
            header = child(envelope, SOAP, "Header")
            context = child(header, CONTEXT, "context")
            child(context, CONTEXT, "authToken", self.token)
        body = child(envelope, SOAP, "Body")
        body.append(request)
        response = self.client.post(
            self.origin + "/service/soap",
            content=ET.tostring(envelope, encoding="utf-8"),
            headers={"Content-Type": "application/soap+xml; charset=utf-8"},
        )
        try:
            result = ET.fromstring(response.content)
        except ET.ParseError as exc:
            raise MailError("Zimbra вернула ответ неизвестного формата.") from exc
        reply = result.find(f"{{{SOAP}}}Body")
        if reply is None or not len(reply):
            raise MailError("Zimbra вернула пустой ответ.")
        operation = reply[0]
        if operation.tag.endswith("}Fault"):
            code = operation.findtext(".//{urn:zimbra}Code") or ""
            if "AUTH" in code:
                raise MailError("Zimbra отклонила вход. Проверьте логин, пароль и настройки почтового аккаунта.")
            raise MailError("Zimbra отклонила операцию. Проверьте подключение или права ящика.")
        response.raise_for_status()
        expected = request.tag.removesuffix("Request") + "Response"
        if operation.tag != expected:
            raise MailError("Zimbra вернула неожиданный ответ.")
        return operation

    def sign_in(self, username: str, password: str) -> None:
        request = ET.Element(f"{{{ACCOUNT}}}AuthRequest", {"persistAuthTokenCookie": "1"})
        child(request, ACCOUNT, "account", username, by="name")
        child(request, ACCOUNT, "password", password)
        attrs = child(request, ACCOUNT, "attrs")
        child(attrs, ACCOUNT, "attr", name="zimbraMailDeliveryAddress")
        result = self.call(request)
        self.token = result.findtext(f"{{{ACCOUNT}}}authToken")
        address = result.findtext(f".//{{{ACCOUNT}}}attr[@name='zimbraMailDeliveryAddress']") or username
        address = parseaddr(address)[1]
        self.address = address if "@" in address else None
        if not self.token:
            raise MailError("Не удалось получить доступ к ящику Zimbra.")
        self.client.cookies.set("ZM_AUTH_TOKEN", self.token)

    def contacts(self, query: str) -> list[dict[str, str]]:
        request = ET.Element(f"{{{MAIL}}}AutoCompleteRequest", {"includeGal": "1"})
        child(request, MAIL, "name", query)
        contacts = []
        for match in self.call(request).findall(f"{{{MAIL}}}match"):
            name_from_address, email = parseaddr(match.get("email", ""))
            if "@" not in email or match.get("isGroup") == "1":
                continue
            name = match.get("full") or match.get("display") or name_from_address or email
            contacts.append({"email": email, "name": " ".join(name.split()), "source": "zimbra"})
        return contacts[:20]

    def _upload_message(self, content: bytes) -> str:
        response = self.client.post(
            self.origin + "/service/upload",
            params={"fmt": "raw,extended"},
            files={"file": ("message.eml", content, "message/rfc822")},
        )
        response.raise_for_status()
        try:
            code, _, data = response.text.split(",", 2)
            aid = json.loads(data)[0]["aid"]
            if code.strip() != "200" or not isinstance(aid, str) or not aid:
                raise ValueError
        except (ValueError, IndexError, KeyError, TypeError) as exc:
            raise MailError("Zimbra не приняла вложение.") from exc
        return aid

    def send(
        self, to: str, subject: str, text: str, request_id: str,
        attachments: list[tuple[str, Path, str]], recipient_name: str | None = None,
    ) -> str | None:
        if not self.address:
            raise MailError("Для отправки Zimbra нужна учётная запись с полным адресом почты.")
        try:
            message = EmailMessage(policy=SMTP)
            message["From"] = Address(addr_spec=self.address)
            message["To"] = Address(display_name=" ".join((recipient_name or "").split()), addr_spec=to)
            message["Subject"] = subject
            message.set_content(text)
            for filename, path, content_type in attachments:
                maintype, _, subtype = content_type.partition("/")
                message.add_attachment(
                    path.read_bytes(), maintype=maintype or "application",
                    subtype=subtype or "octet-stream", filename=filename,
                )
        except ValueError as error:
            raise MailError("Проверьте адрес получателя и заголовки письма.") from error
        message_id = self._upload_message(message.as_bytes())
        request = ET.Element(f"{{{MAIL}}}SendMsgRequest", {"suid": request_id})
        child(request, MAIL, "m", aid=message_id)
        reply = self.call(request)
        sent = reply.find(f"{{{MAIL}}}m")
        return sent.get("id") if sent is not None else None
