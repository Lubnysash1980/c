import time
def print_helper_status():
    print("Helper module active")
if __name__ == '__main__':
    while True:
        print_helper_status()
        time.sleep(15)