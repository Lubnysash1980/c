from flask import Flask, request, jsonify, send_from_directory, abort
import os, time, hashlib
APP_DIR = os.path.dirname(__file__)
REPO = os.path.join(APP_DIR,'repo')
os.makedirs(REPO,exist_ok=True)
AUTH = os.environ.get('CYBRAHAB_TOKEN','')
app = Flask(__name__)
def check_auth():
    if not AUTH:
        return True
    token = request.headers.get('X-Repo-Token') or request.args.get('token')
    return token==AUTH
@app.route('/index')
def index():
    res=[]
    for fn in os.listdir(REPO):
        p=os.path.join(REPO,fn)
        if os.path.isfile(p):
            s=os.stat(p)
            res.append({'name':fn,'size':s.st_size,'mtime':s.st_mtime})
    return jsonify({'modules':res})
@app.route('/modules/<path:name>',methods=['GET','POST'])
def modules(name):
    if '..' in name:
        abort(400)
    path=os.path.join(REPO,name)
    if request.method=='GET':
        if not os.path.exists(path):
            abort(404)
        return send_from_directory(REPO,name,as_attachment=True)
    else:
        if not check_auth():
            return jsonify({'ok':False,'error':'auth required'}),401
        data=request.data
        if not data:
            return jsonify({'ok':False,'error':'empty'}),400
        tmp=path+'.tmp'
        with open(tmp,'wb') as f:
            f.write(data)
        os.replace(tmp,path)
        h=hashlib.sha256(); h.update(data)
        return jsonify({'ok':True,'sha256':h.hexdigest(),'name':name,'mtime':time.time()})
@app.route('/health')
def health():
    return jsonify({'ok':True,'count':len(os.listdir(REPO))})
if __name__=='__main__':
    app.run(host='0.0.0.0',port=8080)
