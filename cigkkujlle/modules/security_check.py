import hashlib
def verify_sha512(file_path):
    try:
        with open(file_path, 'rb') as f:
            data = f.read()
        sha = hashlib.sha512(data).hexdigest()
        return sha
    except Exception as e:
        return str(e)
if __name__ == '__main__':
    print("Security module loaded")