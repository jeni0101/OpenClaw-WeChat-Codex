#!/usr/bin/env python3
"""Shrink PPTX files whose SVG slides repeatedly embed one 4x4 contact sheet.

The generated Xinjiang deck used SVG artwork for each slide. Sixteen SVG files
embedded the complete PNG contact sheet and then clipped a different quadrant.
This preserves the exact slide design while replacing each embedded master PNG
with only the JPEG quadrant that the slide actually displays.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import os
import re
import tempfile
import zipfile
from pathlib import Path

from PIL import Image


CLIP_RE = re.compile(
    r'<clipPath id="(?P<clip>photoClip(?P<index>\d+)_[^"]+)">'
    r'<rect x="(?P<x>[^"]+)" y="(?P<y>[^"]+)" '
    r'width="(?P<width>[^"]+)" height="(?P<height>[^"]+)" '
    r'rx="(?P<radius>[^"]+)"/></clipPath>'
)
IMAGE_RE = re.compile(
    r'<image href="data:image/png;base64,(?P<data>[^"]+)" '
    r'x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" '
    r'preserveAspectRatio="none" clip-path="url\(#(?P<clip>[^)]+)\)"/>'
)


def crop_panel(raw: bytes, index: int, quality: int) -> bytes:
    if index < 0 or index >= 16:
        raise ValueError(f"contact-sheet panel index is outside 0..15: {index}")
    with Image.open(io.BytesIO(raw)) as source:
        source.load()
        if source.width < 4 or source.height < 4:
            raise ValueError("embedded contact sheet is too small")
        row, column = divmod(index, 4)
        bounds = (
            column * source.width // 4,
            row * source.height // 4,
            (column + 1) * source.width // 4,
            (row + 1) * source.height // 4,
        )
        panel = source.convert("RGB").crop(bounds)
        output = io.BytesIO()
        panel.save(output, "JPEG", quality=quality, optimize=True, progressive=True)
        return output.getvalue()


def optimize_svg(svg: bytes, quality: int) -> tuple[bytes, str] | None:
    text = svg.decode("utf-8")
    clip_match = CLIP_RE.search(text)
    image_match = IMAGE_RE.search(text)
    if clip_match is None or image_match is None:
        return None
    if clip_match.group("clip") != image_match.group("clip"):
        raise ValueError("SVG contact-sheet clip and image reference do not match")

    master = base64.b64decode(image_match.group("data"), validate=True)
    panel = crop_panel(master, int(clip_match.group("index")), quality)
    encoded = base64.b64encode(panel).decode("ascii")
    replacement = (
        f'<image href="data:image/jpeg;base64,{encoded}" '
        f'x="{clip_match.group("x")}" y="{clip_match.group("y")}" '
        f'width="{clip_match.group("width")}" height="{clip_match.group("height")}" '
        f'preserveAspectRatio="none" '
        f'clip-path="url(#{clip_match.group("clip")})"/>'
    )
    optimized = text[: image_match.start()] + replacement + text[image_match.end() :]
    return optimized.encode("utf-8"), hashlib.sha256(master).hexdigest()


def copy_info(info: zipfile.ZipInfo) -> zipfile.ZipInfo:
    copied = zipfile.ZipInfo(info.filename, info.date_time)
    copied.comment = info.comment
    copied.extra = info.extra
    copied.create_system = info.create_system
    copied.external_attr = info.external_attr
    copied.internal_attr = info.internal_attr
    copied.flag_bits = info.flag_bits
    return copied


def optimize_pptx(source: Path, destination: Path, quality: int) -> dict[str, int | str]:
    if source.resolve() == destination.resolve():
        raise ValueError("destination must differ from source")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_size = source.stat().st_size
    transformed = 0
    master_hashes: set[str] = set()
    slide_count = 0

    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    os.close(temporary_fd)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(source, "r") as input_archive:
            with zipfile.ZipFile(
                temporary,
                "w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=9,
            ) as output_archive:
                for info in input_archive.infolist():
                    data = input_archive.read(info.filename)
                    if re.fullmatch(r"ppt/slides/slide\d+\.xml", info.filename):
                        slide_count += 1
                    if re.fullmatch(r"ppt/media/image\d+\.svg", info.filename):
                        result = optimize_svg(data, quality)
                        if result is not None:
                            data, master_hash = result
                            master_hashes.add(master_hash)
                            transformed += 1
                    output_archive.writestr(copy_info(info), data)

        with zipfile.ZipFile(temporary, "r") as check:
            bad_member = check.testzip()
            if bad_member is not None:
                raise ValueError(f"optimized PPTX has a corrupt ZIP member: {bad_member}")
        if slide_count != 27:
            raise ValueError(f"expected 27 slides, found {slide_count}")
        if transformed != 16:
            raise ValueError(f"expected 16 contact-sheet SVGs, transformed {transformed}")
        if len(master_hashes) != 1:
            raise ValueError(f"expected one repeated contact sheet, found {len(master_hashes)}")

        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)

    output_size = destination.stat().st_size
    return {
        "sourceBytes": source_size,
        "outputBytes": output_size,
        "savedBytes": source_size - output_size,
        "slides": slide_count,
        "optimizedSlides": transformed,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "outputSha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--jpeg-quality", type=int, default=90)
    args = parser.parse_args()
    if not 75 <= args.jpeg_quality <= 95:
        parser.error("--jpeg-quality must be between 75 and 95")
    print(optimize_pptx(args.source, args.destination, args.jpeg_quality))


if __name__ == "__main__":
    main()
