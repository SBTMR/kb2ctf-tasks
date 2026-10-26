from flask import Flask, render_template, request, redirect, url_for, session
from sqlalchemy import create_engine, text, CursorResult
from sqlalchemy.exc import SQLAlchemyError

import string
import random
import os
import hashlib

from pathlib import Path
from flask import jsonify

ROOT = Path(__file__).resolve().parent
app = Flask(__name__)

app.config['SESSION_COOKIE_NAME'] = 'kb2ctf_sql'
app.secret_key = ''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(25))

db_user = 'lab_app'
db_password = 'kb2ctf_sql_app_demo_password'
db_host = os.environ.get('POSTGRES_HOST', 'sql-db')
db_name = 'kb2ctf'

DATABASE_URL = f'postgresql://{db_user}:{db_password}@{db_host}:5432/{db_name}'
engine = create_engine(DATABASE_URL)

def execute_db(query: str) -> CursorResult:
    with engine.connect() as connection:
        result = connection.execute(text(query))
        connection.commit()
        return result

@app.route('/')
def main():
    return redirect(url_for('register'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if "username" in session and "user_id" in session:
        return redirect(url_for('notes'))

    if request.method == 'GET':
        return render_template('auth.html', mode='login', error=request.args.get('error', default = ''))

    if 'username' not in request.form or 'password' not in request.form or not request.form['username'] or not request.form['password']:
        return redirect(url_for('login', error='No credentials provided'))

    username = request.form['username']
    password = hashlib.sha256(request.form['password'].encode()).hexdigest()

    try:
        result = execute_db(f"SELECT * FROM users WHERE username = '{username}' AND password = '{password}'").fetchone()
        if not result:
            return redirect(url_for('login', error='Invalid credentials'))

        session["user_id"] = result[0]
        session['username'] = result[1]

        return redirect(url_for('notes'))

    except SQLAlchemyError as e:
        return redirect(url_for('login', error='Database error'))

@app.route('/register', methods=['GET', 'POST'])
def register():
    if "username" in session and "user_id" in session:
        return redirect(url_for('notes'))

    if request.method == 'GET':
        return render_template('auth.html', mode='register', error=request.args.get('error', default = ''))

    if 'username' not in request.form or 'password' not in request.form or not request.form['username'] or not request.form['password']:
        return redirect(url_for('register', error='No credentials provided'))

    username = request.form['username']
    password = hashlib.sha256(request.form['password'].encode()).hexdigest()

    try:
        result = execute_db(f"SELECT * FROM users WHERE username = '{username}'").fetchone()

        if result:
            return redirect(url_for('register', error='User already exists'))

        execute_db(f"INSERT INTO users (username, password) VALUES ('{username}', '{password}')")

        return redirect(url_for("login", error="Successfully registered"))
    except SQLAlchemyError as e:
        return redirect(url_for('login', error='Database error'))

@app.route('/notes')
def notes():
    if "user_id" not in session or "username" not in session:
        return redirect(url_for("login"))

    res = execute_db(f"SELECT message FROM notes where user_id='{session['user_id']}'").fetchall()
    notes = list()
    for note in res:
        notes.append(note[0])

    return render_template("notes.html", username=session["username"], notes=notes)

@app.route('/logout', methods=['GET', 'POST'])
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.get('/healthz')
def health():
    try:
        execute_db('SELECT 1')
        return jsonify(status='ready')
    except SQLAlchemyError:
        return jsonify(status='unavailable'), 503
