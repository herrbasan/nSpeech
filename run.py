import os
import sys
import subprocess
import shutil
from pathlib import Path

def main():
    root = Path(__file__).resolve().parent
    server_dir = root / "server"

    print("=========================================")
    print("      Starting nSpeech V3 Server         ")
    print("=========================================")

    # 1. Verify Node.js is installed
    node_executable = shutil.which("node")
    if not node_executable:
        print("[!] Error: Node.js was not found on your system PATH.")
        print("    Please install Node.js (version 22 or newer) to run nSpeech V3.")
        sys.exit(1)

    # 2. Check if node_modules exists, run npm install if not
    node_modules_dir = server_dir / "node_modules"
    if not node_modules_dir.exists():
        print("• First time setup: Node dependencies not found. Installing...")
        npm_executable = shutil.which("npm")
        if not npm_executable:
            print("[!] Error: npm was not found on your system PATH.")
            print("    Please ensure npm is installed alongside Node.js.")
            sys.exit(1)
        
        try:
            subprocess.run([npm_executable, "install"], cwd=str(server_dir), check=True)
            print("• Dependencies successfully installed.")
        except subprocess.CalledProcessError as e:
            print(f"[!] Error: npm install failed. (Exit code: {e.returncode})")
            sys.exit(1)

    # 3. Launch Fastify Node Server
    print("• Booting modern V3 Fastify endpoint gateway...")
    try:
        # We forward all system platform signals (e.g. Ctrl+C) direct to process tree
        result = subprocess.run([node_executable, "index.js"], cwd=str(server_dir))
        sys.exit(result.returncode)
    except KeyboardInterrupt:
        print("\n• Shutting down nSpeech gateway cleanly. Goodbye!")
        sys.exit(0)

if __name__ == "__main__":
    main()
