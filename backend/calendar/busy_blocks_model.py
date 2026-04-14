from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict


def _normalize_color(color: str) -> str:
    value = color.strip()
    if not value:
        return "#3b82f6"
    return value


def _require_non_empty(value: str, field_name: str) -> str:
    clean = value.strip()
    if not clean:
        raise ValueError(f"{field_name} is required.")
    return clean


def _to_utc(iso_datetime: str, field_name: str) -> datetime:
    clean = _require_non_empty(iso_datetime, field_name)
    parsed = datetime.fromisoformat(clean.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class BusyBlock:
    user_id: str
    date: str
    start_time: str
    end_time: str
    updated_at: str
    source_calendar_id: str
    source_calendar_color: str
    source_event_id: str

    def to_item(self) -> Dict[str, str]:
        return {
            "user_id": self.user_id,
            "date": self.date,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "updated_at": self.updated_at,
            "source_calendar_id": self.source_calendar_id,
            "source_calendar_color": self.source_calendar_color,
            "source_event_id": self.source_event_id,
        }


def build_busy_block(
    *,
    user_id: str,
    source_event_id: str,
    source_calendar_id: str,
    source_calendar_color: str,
    google_event_start_iso: str,
    google_event_end_iso: str,
    updated_at_iso: str,
) -> BusyBlock:
    """
    Build a normalized busy-block record from one Google Calendar event instance.

    This does not write to DynamoDB; it only defines and validates the model shape
    so the sync flow can persist records consistently in a later step.
    """
    start_utc = _to_utc(google_event_start_iso, "google_event_start_iso")
    end_utc = _to_utc(google_event_end_iso, "google_event_end_iso")
    if end_utc <= start_utc:
        raise ValueError("google_event_end_iso must be after google_event_start_iso.")

    updated_utc = _to_utc(updated_at_iso, "updated_at_iso")

    return BusyBlock(
        user_id=_require_non_empty(user_id, "user_id"),
        date=start_utc.date().isoformat(),
        start_time=start_utc.time().replace(microsecond=0).isoformat(),
        end_time=end_utc.time().replace(microsecond=0).isoformat(),
        updated_at=updated_utc.isoformat().replace("+00:00", "Z"),
        source_calendar_id=_require_non_empty(source_calendar_id, "source_calendar_id"),
        source_calendar_color=_normalize_color(source_calendar_color),
        source_event_id=_require_non_empty(source_event_id, "source_event_id"),
    )


def busy_block_from_item(item: Dict[str, Any]) -> BusyBlock:
    return BusyBlock(
        user_id=_require_non_empty(str(item.get("user_id", "")), "user_id"),
        date=_require_non_empty(str(item.get("date", "")), "date"),
        start_time=_require_non_empty(str(item.get("start_time", "")), "start_time"),
        end_time=_require_non_empty(str(item.get("end_time", "")), "end_time"),
        updated_at=_require_non_empty(str(item.get("updated_at", "")), "updated_at"),
        source_calendar_id=_require_non_empty(
            str(item.get("source_calendar_id", "")),
            "source_calendar_id",
        ),
        source_calendar_color=_normalize_color(str(item.get("source_calendar_color", ""))),
        source_event_id=_require_non_empty(str(item.get("source_event_id", "")), "source_event_id"),
    )
