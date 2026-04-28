"""
Document version-control helpers.

All file-level operations (copy, move) are done here so the consumer and
views don't need to know about path conventions.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from django.conf import settings
from django.db import transaction
from django.utils import timezone

if TYPE_CHECKING:
    from documents.models import Document, DocumentVersion

logger = logging.getLogger("paperless.versions")


def _versions_dir() -> Path:
    d = settings.VERSIONS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _version_filename(doc_pk: int, version_num: int, role: str, ext: str) -> str:
    """Return the filename (not full path) for a version file."""
    return f"{doc_pk}_{version_num:04d}_{role}{ext}"


def archive_current_version(document: "Document") -> "DocumentVersion":
    """
    Snapshot the current state of *document* into a new DocumentVersion record
    and copy its files into VERSIONS_DIR.

    Returns the newly created DocumentVersion.
    Must be called inside a transaction (the caller is responsible).
    """
    from documents.models import DocumentVersion

    versions_dir = _versions_dir()
    next_num = (document.versions.aggregate(
        m=__import__("django.db.models", fromlist=["Max"]).Max("version_number")
    )["m"] or 0) + 1

    # ── Copy original file ────────────────────────────────────────────────
    src_original = document.source_path
    ext = src_original.suffix if src_original.exists() else ""
    orig_fname = _version_filename(document.pk, next_num, "original", ext)
    dest_original = versions_dir / orig_fname

    if src_original.exists():
        shutil.copy2(src_original, dest_original)
        logger.debug(f"Versions: copied original {src_original} → {dest_original}")
    else:
        orig_fname = ""
        logger.warning(f"Versions: original file missing for document {document.pk}")

    # ── Copy archive file (if present) ────────────────────────────────────
    arch_fname = ""
    if document.has_archive_version and document.archive_path:
        arch_src = document.archive_path
        if arch_src.exists():
            arch_fname = _version_filename(document.pk, next_num, "archive", ".pdf")
            shutil.copy2(arch_src, versions_dir / arch_fname)
            logger.debug(f"Versions: copied archive {arch_src} → {versions_dir / arch_fname}")

    # ── Create the DB record ──────────────────────────────────────────────
    version = DocumentVersion.objects.create(
        document=document,
        version_number=next_num,
        title=document.title,
        content=document.content or "",
        checksum=document.checksum,
        archive_checksum=document.archive_checksum,
        original_filename=document.original_filename,
        mime_type=document.mime_type,
        page_count=document.page_count,
        document_created=document.created,
        original_file=orig_fname,
        archive_file=arch_fname or None,
    )

    logger.info(
        f"Versions: archived document {document.pk} ('{document.title}') "
        f"as version {next_num}"
    )
    return version


def restore_version(version: "DocumentVersion") -> "Document":
    """
    Make *version* the active document state:

    1. Archive the current document state as a new version (preserves history).
    2. Copy the old version's files back to the document's active paths.
    3. Update the Document record with the old version's metadata.
    4. Re-index in Whoosh + Meilisearch.

    Returns the updated Document.
    Must be called inside a transaction.
    """
    from documents.index import add_or_update_document
    from documents.models import Document

    doc = version.document
    versions_dir = _versions_dir()

    with transaction.atomic():
        # 1. Archive the current active state first
        archive_current_version(doc)

        # 2. Copy old version's original file back
        old_original = version.original_path
        if not old_original.exists():
            raise FileNotFoundError(
                f"Version file not found: {old_original}"
            )

        dest_original = doc.source_path
        dest_original.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(old_original, dest_original)

        # 3. Copy old version's archive file back (or remove current archive)
        if version.archive_file and version.archive_path and version.archive_path.exists():
            if doc.archive_path:
                dest_archive = doc.archive_path
                dest_archive.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(version.archive_path, dest_archive)
        else:
            # The restored version had no archive — remove the current one
            if doc.archive_path and doc.archive_path.exists():
                doc.archive_path.unlink(missing_ok=True)

        # 4. Update Document record with old version's metadata
        doc.title = version.title
        doc.content = version.content
        doc.checksum = version.checksum
        doc.archive_checksum = version.archive_checksum
        doc.original_filename = version.original_filename
        doc.mime_type = version.mime_type or doc.mime_type
        doc.page_count = version.page_count
        if version.document_created:
            doc.created = version.document_created
        doc.modified = timezone.now()
        doc.save(
            update_fields=[
                "title", "content", "checksum", "archive_checksum",
                "original_filename", "mime_type", "page_count",
                "created", "modified",
            ]
        )

    # 5. Re-index (outside the transaction so failures don't roll back the restore)
    try:
        add_or_update_document(doc)
    except Exception as e:
        logger.warning(f"Versions: re-index failed after restore of doc {doc.pk}: {e}")

    logger.info(
        f"Versions: restored document {doc.pk} ('{doc.title}') "
        f"from version {version.version_number}"
    )
    return doc
