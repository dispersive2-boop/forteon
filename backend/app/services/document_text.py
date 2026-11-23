"""Bounded text extraction for files selected in the notes composer."""
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from xml.etree import ElementTree
from zipfile import ZipFile


def extract_text(data: bytes, suffix: str) -> str:
    if suffix == ".txt":
        return data.decode("utf-8-sig")[:16000].strip()
    with TemporaryDirectory(prefix="forteon-document-") as directory:
        path = Path(directory) / ("input" + suffix)
        path.write_bytes(data)
        if suffix == ".docx":
            with ZipFile(path) as archive:
                entry = archive.getinfo("word/document.xml")
                if entry.file_size > 4_000_000:
                    raise ValueError("Документ слишком большой для разбора.")
                root = ElementTree.fromstring(archive.read(entry))
                return "\n".join("".join(p.itertext()) for p in root.findall(".//{*}p"))[:16000].strip()
        if suffix == ".pdf":
            text = _run(["pdftotext", "-f", "1", "-l", "8", str(path), "-"])
            if text.strip():
                return text[:16000].strip()
            prefix = Path(directory) / "page"
            _run(["pdftoppm", "-f", "1", "-l", "5", "-scale-to", "1800", "-png", str(path), str(prefix)])
            return "\n".join(_ocr(page) for page in sorted(Path(directory).glob("page-*.png")))[:16000].strip()
        if suffix in {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}:
            return _ocr(path)[:16000].strip()
        raise ValueError("Выберите PDF, DOCX, TXT или изображение.")


def _run(command: list[str]) -> str:
    try:
        result = subprocess.run(command, capture_output=True, timeout=16, check=True)
    except FileNotFoundError as error:
        raise ValueError("На сервере нужен Poppler и Tesseract для разбора сканов.") from error
    except (subprocess.SubprocessError, OSError) as error:
        raise ValueError("Не удалось прочитать файл. Проверьте формат или качество изображения.") from error
    return result.stdout.decode("utf-8", errors="replace")


def _ocr(path: Path) -> str:
    return _run(["tesseract", str(path), "stdout", "-l", "rus+eng"])
