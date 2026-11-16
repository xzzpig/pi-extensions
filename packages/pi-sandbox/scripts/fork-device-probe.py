#!/usr/bin/env python3
"""Non-destructive real-device E2E probe: open KVM and query its API only."""

import fcntl
import json
import os
import stat
import sys


def main():
    device = "/dev/kvm"
    fd = None
    try:
        node = os.lstat(device)
        if not stat.S_ISCHR(node.st_mode):
            raise ValueError("/dev/kvm must be a real character device, not a link")
        fd = os.open(device, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
        opened = os.fstat(fd)
        if not stat.S_ISCHR(opened.st_mode) or opened.st_rdev != node.st_rdev:
            raise ValueError("device identity changed while opening")
        version = fcntl.ioctl(fd, 0xAE00, 0)  # KVM_GET_API_VERSION, no VM creation
        result = {
            "device": device,
            "type": "character",
            "major": os.major(opened.st_rdev),
            "minor": os.minor(opened.st_rdev),
            "operation": "KVM_GET_API_VERSION",
            "apiVersion": version,
            "ok": version == 12,
        }
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    except (OSError, ValueError) as error:
        print(json.dumps({
            "device": device,
            "ok": False,
            "errno": getattr(error, "errno", None),
            "error": str(error),
        }))
        return 1
    finally:
        if fd is not None:
            os.close(fd)


if __name__ == "__main__":
    sys.exit(main())
