from flask import Flask, redirect, url_for, request, render_template, make_response
import os
import random
import string
from pathlib import Path

import importlib.util

spec = importlib.util.spec_from_file_location('lab_jwtutil', Path(__file__).with_name('jwtutil.py'))
jwtutil = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jwtutil)
gen_jwt, decode_jwt = jwtutil.gen_jwt, jwtutil.decode_jwt
COOKIE = 'flag_token'

from flask import jsonify

ROOT = Path(__file__).resolve().parent
app = Flask(__name__)

users = {"admin": "".join(random.choice(string.ascii_uppercase + string.digits) for _ in range(25))}

@app.route("/")
def main():
    return redirect(url_for("register"))

@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "GET":
        return render_template("auth.html", mode="register", error=request.args.get("error", default = ""))

    username = request.form['username']
    password = request.form['password']

    if username in users:
        return redirect(url_for("register", error="User already exists"))

    users[username] = password
    return redirect(url_for("login", error="Successfully registered"))

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template("auth.html", mode="login", error=request.args.get("error", default = ""))

    username = request.form['username']
    password = request.form['password']

    if username not in users:
        return redirect(url_for("login", error="User doesn't exists"))

    if password != users[username]:
        return redirect(url_for("login", error="Wrong credentials"))

    resp = make_response(redirect("/flag"))
    resp.set_cookie('flag_token', gen_jwt(username))
    return resp

@app.route("/flag", methods=["GET"])
def flag():
    if "flag_token" not in request.cookies:
        return redirect(url_for("login"))

    try:
        payload = decode_jwt(request.cookies["flag_token"])
    except:
        return redirect(url_for("login"))

    if "username" not in payload:
        return redirect(url_for("login"))

    if payload["username"] != "admin":
        return render_template('admin.html', username=payload['username'], flag=None)

    return render_template('admin.html', username=payload['username'], flag=read_flag())

@app.route('/logout', methods=['GET', 'POST'])
def logout():
    response = make_response(redirect(url_for('login')))
    response.delete_cookie(COOKIE)
    return response


def read_flag():
    return 'KB2CTF{jwt_demo}'

@app.get('/healthz')
def health():
    return jsonify(status='ready')
