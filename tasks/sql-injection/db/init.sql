CREATE ROLE lab_app LOGIN PASSWORD :'app_password';
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username varchar(100) UNIQUE,
    password varchar(100)
);

CREATE TABLE IF NOT EXISTS notes (
    id SERIAL PRIMARY KEY,
    user_id INT,
    message varchar(100),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO users (username, password) VALUES ('robert', 'bebebe_it_is_a_hash');
INSERT INTO notes (user_id, message) VALUES (1, 'bebebe');
INSERT INTO notes (user_id, message) VALUES (1, :'lab_flag');
INSERT INTO notes (user_id, message) VALUES (1, 'bababa');
GRANT CONNECT ON DATABASE kb2ctf TO lab_app;
ALTER SCHEMA public OWNER TO lab_app;
ALTER TABLE users OWNER TO lab_app;
ALTER TABLE notes OWNER TO lab_app;
