from flask import Blueprint, render_template, request, jsonify
import subprocess
from pathlib import Path

runner = Blueprint('runner', __name__, template_folder='templates')
SCRIPTS_DIR = Path('./scripts')

@runner.route('/runner', methods=['GET'])
def runner_ui():
    scripts = [p.name for p in SCRIPTS_DIR.glob('*.py')]
    return render_template('runner.html', scripts=scripts)

@runner.route('/runner/run', methods=['POST'])
def run_script():
    script = request.form.get('script')
    if not script or not (SCRIPTS_DIR / script).exists():
        return jsonify({'status':'error','message':'Script not found'}), 400
    try:
        subprocess.Popen(['python3', str(SCRIPTS_DIR / script)])
        return jsonify({'status':'ok','message':f'{script} запущено'})
    except Exception as e:
        return jsonify({'status':'error','message':str(e)}), 500
