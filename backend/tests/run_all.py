"""一键跑全部后端测试（CI 入口）。

为什么需要：这套测试原本是 24 个独立可执行脚本（每个都有 `main()`，直接
`python tests/test_xxx.py` 跑）。功能上没问题，但没有统一入口就没法挂 CI，
也没法一眼看出"到底有没有全过" —— 之前每次都是我手工写循环。

用法：
  cd web/backend
  python tests/run_all.py            # 全部
  python tests/run_all.py -v         # 打印每个用例的完整输出
  python tests/run_all.py --filter ops

退出码：0 = 全过；1 = 有失败（CI 直接用）。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def discover(pattern: str) -> list[Path]:
    return sorted(p for p in HERE.glob("test_*.py") if not pattern or pattern in p.name)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true", help="打印每个用例的完整输出")
    ap.add_argument("--filter", default="", help="只跑文件名包含该关键字的用例")
    args = ap.parse_args()

    files = discover(args.filter)
    if not files:
        print(f"没有匹配的测试文件（filter={args.filter!r}）")
        return 1

    print(f"后端测试：{len(files)} 个文件\n" + "-" * 62)
    passed: list[str] = []
    failed: list[tuple[str, str]] = []
    t0 = time.time()
    for path in files:
        start = time.time()
        proc = subprocess.run([sys.executable, "-X", "utf8", str(path)],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace")
        dt = time.time() - start
        if proc.returncode == 0:
            passed.append(path.name)
            print(f"  PASS  {path.name:<34} {dt:5.1f}s")
            if args.verbose and proc.stdout:
                print("        " + proc.stdout.strip().replace("\n", "\n        ")[-1500:])
        else:
            tail = (proc.stdout or "") + (proc.stderr or "")
            failed.append((path.name, tail))
            print(f"  FAIL  {path.name:<34} {dt:5.1f}s")

    print("-" * 62)
    print(f"通过 {len(passed)} / {len(files)}，用时 {time.time() - t0:.1f}s")
    if failed:
        print("\n失败明细：")
        for name, tail in failed:
            print(f"\n=== {name} ===")
            print(tail.strip()[-1200:])
        return 1
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
