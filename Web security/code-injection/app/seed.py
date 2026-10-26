from pathlib import Path

# Training fixture: materialized inside the image, outside the web directory.
FLAG = 'KB2CTF{code_injection_demo}'

if __name__ == "__main__":
    Path("/flag.txt").write_text(FLAG + "\n", encoding="utf-8")
