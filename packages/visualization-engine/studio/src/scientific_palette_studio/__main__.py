from __future__ import annotations

import argparse

import uvicorn

from .rendering import render_all


def main() -> None:
    parser = argparse.ArgumentParser(description="Scientific Palette Studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--render-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.render_only:
        paths = render_all(force=args.force)
        print(f"Rendered {len(paths)} preview files.")
        return

    uvicorn.run("scientific_palette_studio.api:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()

