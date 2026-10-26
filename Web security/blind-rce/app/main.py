from flask import Flask, request, render_template, jsonify
from subprocess import run
import json

app = Flask(__name__)

def create_resp(message: str) -> dict[str:str]:
    return jsonify({"message": message})

@app.route("/")
def main():
    return render_template("index.html")

@app.route("/api/pinger", methods=['POST'])
def pinger():
    data = json.loads(request.data)
    if "ip" not in data:
        return create_resp("The IP address was not specified")

    data = run("ping %s -c 1" % data["ip"], capture_output=True, shell=True, text=True)
    if data.stderr:
        return create_resp("bebebe error")

    return create_resp("bebebe pinged")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=51338, debug=False)
