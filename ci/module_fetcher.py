import requests, os, time
BASE=os.path.dirname(__file__)
TARGET=os.path.join(BASE,'modules')
os.makedirs(TARGET,exist_ok=True)
CYBRA=os.environ.get('CYBRAHAB_URL','http://127.0.0.1:8080')
def fetch_index():
    try:
        r=requests.get(CYBRA.rstrip('/')+'/index',timeout=2)
        if r.status_code==200:
            return r.json().get('modules',[])
    except:
        pass
    return []
def fetch_module(name):
    try:
        r=requests.get(CYBRA.rstrip('/')+'/modules/'+name,timeout=4)
        if r.status_code==200:
            return r.content
    except:
        pass
    return None
if __name__=='__main__':
    while True:
        try:
            idx=fetch_index()
            for e in idx:
                name=e['name']
                cont=fetch_module(name)
                if cont:
                    with open(os.path.join(TARGET,name),'wb') as f:
                        f.write(cont)
                    print('fetched',name)
        except Exception as ex:
            print('err',ex)
        time.sleep(15)
