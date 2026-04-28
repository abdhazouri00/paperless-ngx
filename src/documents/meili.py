"""
Meilisearch integration for paperless-ngx.

This module provides a clean wrapper around the Meilisearch Python client.
It runs alongside Whoosh — if Meilisearch is unavailable the rest of the
application continues to work through Whoosh transparently.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from django.conf import settings

if TYPE_CHECKING:
    import meilisearch

logger = logging.getLogger("paperless.meili")

# ── Index configuration ───────────────────────────────────────────────────────

SEARCHABLE_ATTRIBUTES = [
    "title",
    "content",
    "correspondent",
    "document_type",
    "tags",
    "notes",
    "custom_fields",
    "original_filename",
]

FILTERABLE_ATTRIBUTES = [
    "owner_id",
    "viewer_ids",
    "correspondent_id",
    "tag_ids",
    "type_id",
    "created_timestamp",
    "added_timestamp",
]

SORTABLE_ATTRIBUTES = [
    "title",
    "correspondent",
    "created_timestamp",
    "added_timestamp",
    "asn",
]

# Attribute weights: fields listed earlier get higher relevance.
# Meilisearch uses this order to break ties when ranking results.
ATTRIBUTES_FOR_RANKING = [
    "title",
    "correspondent",
    "document_type",
    "tags",
    "content",
    "notes",
    "custom_fields",
    "original_filename",
]


# ── Client helpers ────────────────────────────────────────────────────────────


def get_client() -> meilisearch.Client | None:
    """
    Return a configured Meilisearch client, or None if disabled / unreachable.
    Failures are logged as warnings so document processing is never interrupted.
    """
    if not settings.MEILISEARCH_ENABLED:
        return None
    try:
        import meilisearch as ms

        client = ms.Client(settings.MEILISEARCH_URL, settings.MEILISEARCH_MASTER_KEY)
        # health() raises if the server is unreachable
        client.health()
        return client
    except Exception as e:
        logger.warning(f"Meilisearch unavailable, falling back to Whoosh: {e}")
        return None


def get_index(client: meilisearch.Client | None = None):
    """Return the documents index, creating and configuring it if needed."""
    if client is None:
        client = get_client()
    if client is None:
        return None
    try:
        index_name = settings.MEILISEARCH_INDEX_NAME
        # create_index is idempotent — no-op if already exists
        client.create_index(index_name, {"primaryKey": "id"})
        idx = client.index(index_name)
        _configure_index(idx)
        return idx
    except Exception as e:
        logger.warning(f"Could not get/create Meilisearch index: {e}")
        return None


def _configure_index(idx) -> None:
    """Apply searchable/filterable/sortable settings to the index."""
    try:
        idx.update_settings(
            {
                "searchableAttributes": SEARCHABLE_ATTRIBUTES,
                "filterableAttributes": FILTERABLE_ATTRIBUTES,
                "sortableAttributes": SORTABLE_ATTRIBUTES,
                "rankingRules": [
                    "words",
                    "typo",
                    "proximity",
                    "attribute",
                    "sort",
                    "exactness",
                ],
            }
        )
    except Exception as e:
        logger.warning(f"Could not configure Meilisearch index settings: {e}")


# ── Document payload ──────────────────────────────────────────────────────────


def _to_timestamp(value) -> int:
    """
    Convert a date or datetime to a UTC Unix timestamp integer.
    Document.created is a DateField (date only); Document.added is DateTimeField.
    """
    if value is None:
        return 0
    import datetime as dt
    if isinstance(value, dt.datetime):
        return int(value.timestamp())
    if isinstance(value, dt.date):
        # Treat a bare date as midnight UTC
        return int(dt.datetime(value.year, value.month, value.day, tzinfo=dt.timezone.utc).timestamp())
    return 0


def _get_viewer_ids(doc) -> list[int]:
    """
    Return list of user IDs that have explicit view permission on this document
    via Guardian (i.e. not the owner, but granted access).
    """
    try:
        from guardian.shortcuts import get_users_with_perms

        return list(
            get_users_with_perms(doc, only_with_perms_in=["view_document"])
            .exclude(pk=doc.owner_id)
            .values_list("id", flat=True)
        )
    except Exception:
        return []


def build_document_payload(doc) -> dict:
    """
    Build the dict to send to Meilisearch for a single document.
    All heavy relational data is flattened into primitives.
    """
    tag_names = list(doc.tags.values_list("name", flat=True))
    tag_ids = list(doc.tags.values_list("id", flat=True))

    notes_text = " ".join(n.note for n in doc.notes.all() if n.note)

    custom_fields_text = " ".join(
        str(cf.value)
        for cf in doc.custom_fields.all()
        if cf.value is not None and cf.value != ""
    )

    viewer_ids = _get_viewer_ids(doc)

    return {
        "id": doc.pk,
        "title": doc.title or "",
        "content": doc.content or "",
        "correspondent": doc.correspondent.name if doc.correspondent else "",
        "correspondent_id": doc.correspondent_id,
        "document_type": doc.document_type.name if doc.document_type else "",
        "type_id": doc.document_type_id,
        "tags": tag_names,
        "tag_ids": tag_ids,
        "notes": notes_text,
        "custom_fields": custom_fields_text,
        "original_filename": doc.original_filename or "",
        "asn": doc.archive_serial_number,
        "owner_id": doc.owner_id,
        "viewer_ids": viewer_ids,
        "created_timestamp": _to_timestamp(doc.created),
        "added_timestamp": _to_timestamp(doc.added),
    }


# ── Index / delete single document ───────────────────────────────────────────


def index_document(doc) -> None:
    """
    Add or update a single document in Meilisearch.
    Exceptions are swallowed — a Meilisearch outage must never break consumption.
    """
    try:
        idx = get_index()
        if idx is None:
            return
        payload = build_document_payload(doc)
        idx.add_documents([payload])
        logger.debug(f"Meilisearch: indexed document {doc.pk}")
    except Exception as e:
        logger.warning(f"Meilisearch: failed to index document {doc.pk}: {e}")


def delete_document(doc_id: int) -> None:
    """
    Remove a document from the Meilisearch index by ID.
    Exceptions are swallowed.
    """
    try:
        idx = get_index()
        if idx is None:
            return
        idx.delete_document(doc_id)
        logger.debug(f"Meilisearch: deleted document {doc_id}")
    except Exception as e:
        logger.warning(f"Meilisearch: failed to delete document {doc_id}: {e}")


# ── Search ────────────────────────────────────────────────────────────────────


def _build_permission_filter(user) -> str | None:
    """
    Build a Meilisearch filter expression that mirrors paperless permission rules:
    - Superusers see everything (no filter)
    - Regular users see: docs they own OR shared with them OR unowned docs
    """
    if user.is_superuser:
        return None
    uid = user.pk
    return f"owner_id = {uid} OR viewer_ids = {uid} OR owner_id IS NULL"


def search(
    query: str,
    user,
    page: int = 1,
    page_size: int = 25,
) -> tuple[list[int], int] | tuple[None, None]:
    """
    Search Meilisearch and return (ordered_doc_ids, total_hits).
    Returns (None, None) on failure so the caller can fall back to Whoosh.

    We fetch page_size * 5 results and let Django re-filter by DB permissions
    (double-enforcement), then trim to page_size after DB filtering.
    Fetching extra results compensates for any that might be filtered out.
    """
    try:
        idx = get_index()
        if idx is None:
            return None, None

        permission_filter = _build_permission_filter(user)

        search_params: dict = {
            "limit": page_size * 5,
            "offset": 0,
            "attributesToHighlight": ["title", "content", "notes"],
            "highlightPreTag": "<mark>",
            "highlightPostTag": "</mark>",
        }
        if permission_filter:
            search_params["filter"] = permission_filter

        result = idx.search(query, search_params)

        hits = result.get("hits", [])
        total = result.get("estimatedTotalHits", len(hits))

        ordered_ids = [hit["id"] for hit in hits]
        return ordered_ids, total

    except Exception as e:
        logger.warning(f"Meilisearch search failed, falling back to Whoosh: {e}")
        return None, None


# ── Bulk reindex ──────────────────────────────────────────────────────────────


def reindex_all(*, progress_bar_disable: bool = True) -> None:
    """
    Bulk-reindex all documents into Meilisearch.
    Called from the document_index management command.
    """
    from documents.models import Document

    try:
        import tqdm

        client = get_client()
        if client is None:
            logger.warning("Meilisearch unavailable — skipping Meilisearch reindex")
            return

        # Drop and recreate for a clean slate
        index_name = settings.MEILISEARCH_INDEX_NAME
        try:
            client.delete_index(index_name)
        except Exception:
            pass  # index may not exist yet

        idx = get_index(client)
        if idx is None:
            return

        documents = (
            Document.objects.select_related(
                "correspondent", "document_type", "storage_path", "owner"
            )
            .prefetch_related("tags", "notes", "custom_fields")
            .all()
        )

        batch: list[dict] = []
        batch_size = 500

        for doc in tqdm.tqdm(documents, disable=progress_bar_disable, desc="Meilisearch reindex"):
            batch.append(build_document_payload(doc))
            if len(batch) >= batch_size:
                idx.add_documents(batch)
                batch = []

        if batch:
            idx.add_documents(batch)

        logger.info(f"Meilisearch: reindexed {documents.count()} documents")

    except Exception as e:
        logger.error(f"Meilisearch reindex failed: {e}")
