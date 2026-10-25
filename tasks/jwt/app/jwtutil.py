import jwt

secret = "omg_is_it_a_secret?"

def gen_jwt(username: str) -> str:
    payload = {
        "username": username,
    }
    token = jwt.encode(payload, secret, algorithm="HS256")
    return token

def decode_jwt(token: str) -> dict:
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
        return payload
    except Exception as e:
        raise e
