"""Rebuild an image source’s outputs.json from its per-set QA records."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import tempfile
from pathlib import Path


KEYS = {
    "portrait": {"plain-faithful", "plain-corrected", "setting-faithful", "setting-corrected"},
    "object": {"light-faithful", "light-corrected", "dark-faithful", "dark-corrected"},
    "scene": {"faithful", "light-correction", "full-correction"},
}


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def read_record(root, path, inventory, previous):
    record = json.loads(path.read_text(encoding="utf-8"))
    item_id = path.stem
    if item_id not in inventory:
        raise ValueError("unknown inventory ID")
    keys = KEYS[inventory[item_id]["kind"]]
    variants = []
    seen = set()
    cache = {v["key"]: v for v in previous.get("variants", [])}
    for variant in record["variants"]:
        key = variant["key"]
        if key not in keys or key in seen:
            raise ValueError(f"unexpected or duplicate variant {key!r}")
        relative = Path(variant["path"])
        image = (root / relative).resolve()
        if relative.is_absolute() or root not in image.parents or not image.is_file() or not image.stat().st_size:
            raise ValueError(f"missing or invalid image {relative}")
        seen.add(key)
        stat = image.stat()
        fingerprint = {"path": relative.as_posix(), "size": stat.st_size, "modifiedNs": str(stat.st_mtime_ns)}
        cached = cache.get(key, {})
        checksum = cached.get("sha256") if all(cached.get(k) == v for k, v in fingerprint.items()) else None
        variants.append({"key": key, **fingerprint, "sha256": checksum or digest(image)})
    if record.get("reviewed") is True and seen != keys:
        raise ValueError(f"reviewed set is missing {sorted(keys - seen)}")
    if len({v["sha256"] for v in variants}) != len(variants):
        raise ValueError("identical image files under different variant keys")
    return {"reviewed": record.get("reviewed") is True, "variants": variants, "notes": record.get("notes", "")}


def rebuild(root):
    inventory_path = root / "inventory.json"
    items = json.loads(inventory_path.read_text(encoding="utf-8"))["items"]
    inventory = {str(row["id"]): row for row in items}
    outputs = {}
    output = root / "outputs.json"
    previous = {}
    if output.exists():
        try:
            previous = json.loads(output.read_text(encoding="utf-8"))
        except ValueError:
            pass
    for path in sorted((root / "qa").glob("*.json")):
        try:
            outputs[path.stem] = read_record(root, path, inventory, previous.get(path.stem, {}))
        except (ValueError, OSError, KeyError, TypeError) as error:
            raise SystemExit(f"{path.name}: {error}")
    for item_id, item in inventory.items():
        record = outputs.get(item_id, {})
        if record.get("reviewed"):
            continue
        folder = root / "variants" / item_id
        expected = KEYS[item["kind"]]
        keys = {v["key"] for v in record.get("variants", [])}
        if folder.is_dir():
            keys.update(path.stem for path in folder.iterdir()
                        if path.stem in expected and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                        and path.is_file() and path.stat().st_size)
        if keys:
            outputs[item_id] = {"reviewed": False, "generatedKeys": sorted(keys), "variants": [], "notes": ""}
    payload = json.dumps(outputs, ensure_ascii=False, separators=(",", ":")) + "\n"
    with tempfile.NamedTemporaryFile("w", dir=root, delete=False, encoding="utf-8") as stream:
        stream.write(payload)
    os.replace(stream.name, output)
    print(f"Indexed {len(outputs)} sets, {sum(v['reviewed'] for v in outputs.values())} reviewed.")


@contextmanager
def rebuild_lock(root):
    # Keep simultaneous builders from publishing their snapshots out of order.
    lock_name = hashlib.sha256(os.fsencode(root)).hexdigest()
    with (Path(tempfile.gettempdir()) / ("art-review-" + lock_name + ".lock")).open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image_source", type=Path)
    root = parser.parse_args().image_source.expanduser().resolve()
    if not (root / "qa").is_dir():
        parser.error(f"Missing QA folder in {root}")
    with rebuild_lock(root):
        rebuild(root)
