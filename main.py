import base64
import os
import urllib.request

import cv2
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ─── تحميل موديل DNN (أدق بكتير من Haar Cascade) ─────────────────────────────
# ✅ FIX: DNN بيديك دقة 95%+ بدل Haar اللي بيفشل في الإضاءة الضعيفة أو الزاوية
PROTO_PATH = "deploy.prototxt"
MODEL_PATH = "res10_300x300_ssd_iter_140000.caffemodel"

PROTO_URL = (
    "https://raw.githubusercontent.com/opencv/opencv/master"
    "/samples/dnn/face_detector/deploy.prototxt"
)
MODEL_URL = (
    "https://github.com/opencv/opencv_3rdparty/raw/"
    "dnn_samples_face_detector_20170830/"
    "res10_300x300_ssd_iter_140000.caffemodel"
)

if not os.path.exists(PROTO_PATH):
    print("📥 Downloading deploy.prototxt ...")
    urllib.request.urlretrieve(PROTO_URL, PROTO_PATH)
    print("✅ deploy.prototxt downloaded.")

if not os.path.exists(MODEL_PATH):
    print("📥 Downloading DNN face model (~10MB) ...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print("✅ DNN model downloaded.")

face_net = cv2.dnn.readNetFromCaffe(PROTO_PATH, MODEL_PATH)
# ─── Profile Cascade كـ backup للكشف الجانبي لو DNN ما أمسكوش ─────────────────
profile_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + 'haarcascade_profileface.xml'
)

# ─── عداد ثبات التليفون ────────────────────────────────────────────────────────
phone_confirm_count = 0
PHONE_THRESHOLD     = 3


def detect_phone(gray, frame_h, frame_w):
    """كشف التليفون عن طريق شكله المستطيل المميز."""
    blurred     = cv2.GaussianBlur(gray, (5, 5), 0)
    edges       = cv2.Canny(blurred, 30, 100)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area  = frame_h * frame_w

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


def detect_faces_dnn(frame, h, w, confidence_threshold=0.55):
    """
    كشف الوجوه بـ DNN وبيرجع list من:
    {'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'confidence'}
    """
    blob = cv2.dnn.blobFromImage(
        frame, 1.0, (300, 300),
        (104.0, 177.0, 123.0), swapRB=False
    )
    face_net.setInput(blob)
    detections = face_net.forward()

    faces = []
    for i in range(detections.shape[2]):
        conf = float(detections[0, 0, i, 2])
        if conf < confidence_threshold:
            continue
        box = detections[0, 0, i, 3:7] * np.array([w, h, w, h])
        x1, y1, x2, y2 = box.astype(int)
        faces.append({
            'x1': x1, 'y1': y1,
            'x2': x2, 'y2': y2,
            'cx': (x1 + x2) / 2,
            'cy': (y1 + y2) / 2,
            'confidence': conf
        })
    return faces


@app.route('/detect_face', methods=['POST'])
def detect_face():
    global phone_confirm_count
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({'focused': True, 'reason': 'no_image'})

        # ─── فك تشفير الصورة ──────────────────────────────────────────────────
        image_data  = data['image'].split(",")[1]
        image_bytes = base64.b64decode(image_data)
        nparr       = np.frombuffer(image_bytes, np.uint8)
        frame       = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            return jsonify({'focused': True, 'reason': 'decode_failed'})

        # ✅ FIX: تكبير الصورة لـ 320x240 لتحسين دقة DNN
        frame = cv2.resize(frame, (320, 240), interpolation=cv2.INTER_LINEAR)
        h, w  = frame.shape[:2]
        gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray  = cv2.equalizeHist(gray)

        # ─── 1) كشف التليفون ──────────────────────────────────────────────────
        if detect_phone(gray, h, w):
            phone_confirm_count += 1
        else:
            phone_confirm_count = max(0, phone_confirm_count - 1)

        if phone_confirm_count >= PHONE_THRESHOLD:
            return jsonify({'focused': False, 'reason': 'phone'})

        # ─── 2) كشف الوجه بـ DNN ──────────────────────────────────────────────
        faces = detect_faces_dnn(frame, h, w)

        if faces:
            # خد الوجه الأعلى ثقة
            best = max(faces, key=lambda f: f['confidence'])
            cx   = best['cx']

            # ✅ FIX: لو الوجه يمين أو شمال الإطار = تشتت
            # الثلث الأيسر = شايل بيبص شمال، الثلث الأيمن = بيبص يمين
            if cx < w * 0.28:
                return jsonify({'focused': False, 'reason': 'sideways_left'})
            if cx > w * 0.72:
                return jsonify({'focused': False, 'reason': 'sideways_right'})

            return jsonify({'focused': True, 'reason': 'frontal'})

        # ─── 3) لو DNN ما لاقاش وجه — جرّب Profile Cascade للجانبي ────────────
        profile_right = profile_cascade.detectMultiScale(
            gray, scaleFactor=1.2, minNeighbors=3, minSize=(30, 30)
        )
        if len(profile_right) > 0:
            return jsonify({'focused': False, 'reason': 'sideways_right'})

        flipped      = cv2.flip(gray, 1)
        profile_left = profile_cascade.detectMultiScale(
            flipped, scaleFactor=1.2, minNeighbors=3, minSize=(30, 30)
        )
        if len(profile_left) > 0:
            return jsonify({'focused': False, 'reason': 'sideways_left'})

        # ─── 4) مفيش وجه خالص = بيبص للأسفل = مركّز ✅ ───────────────────────
        return jsonify({'focused': True, 'reason': 'looking_down'})

    except Exception as e:
        return jsonify({'focused': True, 'reason': 'error', 'error': str(e)})


if __name__ == '__main__':
    print("🚀 Sentinel Backend Running on http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True)