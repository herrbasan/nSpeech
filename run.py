import sys
import os
from pathlib import Path
import uvicorn

if __name__ == "__main__":
    # Ensure the src directory is in the Python path
    src_dir = str(Path(__file__).parent / "src")
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)
    
    os.environ["PYTHONPATH"] = src_dir + os.pathsep + os.environ.get("PYTHONPATH", "")

    print("=========================================")
    print("      Starting nSpeech API Server        ")
    print("=========================================")
    print("â€¢ Dashboard: http://127.0.0.1:8000/")
    print("â€¢ Stop Server: Press Ctrl+C")
    print("=========================================\n")

    try:
        # Run the server
        uvicorn.run("nspeech.server:app", host="127.0.0.1", port=8000, reload=True)
    except KeyboardInterrupt:
        print("\nShutting down nSpeech gracefully...")
