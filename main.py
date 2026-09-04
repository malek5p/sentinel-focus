import os
import base64
import cv2
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

# ─── خد الملفات من نفس الفولدر مباشرة — مش محتاج فولدر static ───────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path='')
CORS(app)

# ─── كواشف OpenCV ────────────────────────────────────────────────────────────
face_cascade    = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
profile_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')

phone_confirm_count = 0
PHONE_THRESHOLD     = 3


def detect_phone(gray, frame_h, frame_w):
    blurred  = cv2.GaussianBlur(gray, (5, 5), 0)
    edges    = cv2.Canny(blurred, 30, 100)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area   = frame_h * frame_w
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < frame_area * 0.03 or area > frame_area * 0.35:
            continue
        peri   = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)
        if len(approx) != 4:
            continue
        x, y, w, h = cv2.boundingRect(approx)
        if h == 0:
            continue
        ar             = w / h
        is_phone_shape = (0.40 <= ar <= 0.65) or (1.50 <= ar <= 2.50)
        not_top        = (y + h // 2) > frame_h * 0.20
        if is_phone_shape and not_top:
            return True
    return False


# ─── الصفحة الرئيسية ─────────────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


# ─── API: كشف الوجه ───────────────────────────────────────────────────────────
@app.route('/detect_face', methods=['POST'])
def detect_face():
    global phone_confirm_count
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({'focused': True, 'reason': 'no_image'})

        image_data  = data['image'].split(",")[1]
        image_bytes = base64.b64decode(image_data)
        nparr       = np.frombuffer(image_bytes, np.uint8)
        frame       = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            return jsonify({'focused': True, 'reason': 'decode_failed'})

        h, w = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)

        if detect_phone(gray, h, w):
            phone_confirm_count += 1
        else:
            phone_confirm_count = max(0, phone_confirm_count - 1)

        if phone_confirm_count >= PHONE_THRESHOLD:
            return jsonify({'focused': False, 'reason': 'phone'})

        frontal = face_cascade.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=3, minSize=(40, 40))
        if len(frontal) > 0:
            return jsonify({'focused': True, 'reason': 'frontal'})

        profile_right = profile_cascade.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=3, minSize=(40, 40))
        if len(profile_right) > 0:
            return jsonify({'focused': False, 'reason': 'sideways_right'})

        flipped      = cv2.flip(gray, 1)
        profile_left = profile_cascade.detectMultiScale(flipped, scaleFactor=1.2, minNeighbors=3, minSize=(40, 40))
        if len(profile_left) > 0:
            return jsonify({'focused': False, 'reason': 'sideways_left'})

        return jsonify({'focused': True, 'reason': 'looking_down'})

    except Exception as e:
        return jsonify({'focused': True, 'reason': 'error', 'error': str(e)})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)