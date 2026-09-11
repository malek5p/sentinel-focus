import base64
import os
import cv2
import numpy as np
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
CORS(app)

face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
profile_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_profileface.xml"
)

# CLAHE بيتعمل مرة واحدة بس — أسرع وأحسن من equalizeHist
clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))

phone_confirm_count = 0
PHONE_THRESHOLD     = 3
frame_counter       = 0


def preprocess(gray):
    """تحسين سريع — بدون denoising عشان متعملش timeout"""
    h, w = gray.shape
    # بس نصغّر لو أكبر من 320 — ماننفعش نكبّر
    if w > 320:
        scale = 320 / w
        gray  = cv2.resize(gray, (320, int(h * scale)), interpolation=cv2.INTER_AREA)
    # CLAHE أحسن من equalizeHist خصوصاً للإضاءة الغير منتظمة
    gray = clahe.apply(gray)
    return gray


def detect_sideways(gray):
    """
    كشف النظر يمين أو شمال — بإعدادات حساسة جداً
    minNeighbors=1 و scaleFactor=1.1 عشان ميفوتوش حاجة
    """
    # يمين
    p_right = profile_cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=1, minSize=(20, 20)
    )
    if len(p_right) > 0:
        return True

    # شمال
    flipped = cv2.flip(gray, 1)
    p_left  = profile_cascade.detectMultiScale(
        flipped, scaleFactor=1.1, minNeighbors=1, minSize=(20, 20)
    )
    if len(p_left) > 0:
        return True

    return False


def detect_phone(gray):
    small   = cv2.resize(gray, (160, 120))
    sh, sw  = small.shape
    blurred = cv2.GaussianBlur(small, (3, 3), 0)
    edges   = cv2.Canny(blurred, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area  = sh * sw
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < frame_area * 0.03 or area > frame_area * 0.35:
            continue
        peri   = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)
        if len(approx) != 4:
            continue
        x, y, w, h = cv2.boundingRect(approx)
        if h == 0:
            continue
        ar             = w / h
        is_phone_shape = (0.40 <= ar <= 0.65) or (1.50 <= ar <= 2.50)
        not_top        = (y + h // 2) > sh * 0.20
        if is_phone_shape and not_top:
            return True
    return False


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/detect_face", methods=["POST"])
def detect_face():
    global phone_confirm_count, frame_counter
    try:
        data = request.json
        if not data or "image" not in data:
            return jsonify({"focused": True, "reason": "no_image"})

        image_bytes = base64.b64decode(data["image"].split(",")[1])
        nparr       = np.frombuffer(image_bytes, np.uint8)
        frame       = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            return jsonify({"focused": True, "reason": "decode_failed"})

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = preprocess(gray)

        # ─── 1. تليفون؟ كل 3 frames ──────────────────────────────────────────
        frame_counter += 1
        if frame_counter % 3 == 0:
            if detect_phone(gray):
                phone_confirm_count += 1
            else:
                phone_confirm_count = max(0, phone_confirm_count - 1)

        if phone_confirm_count >= PHONE_THRESHOLD:
            return jsonify({"focused": False, "reason": "phone"})

        # ─── 2. وجه أمامي = مركّز ✅ ──────────────────────────────────────────
        frontal = face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=3, minSize=(25, 25)
        )
        if len(frontal) > 0:
            return jsonify({"focused": True, "reason": "frontal"})

        # ─── 3. وجه جانبي = تشتت ❌ ───────────────────────────────────────────
        if detect_sideways(gray):
            return jsonify({"focused": False, "reason": "sideways"})

        # ─── 4. مفيش وجه = بيبص للأسفل = مركّز ✅ ────────────────────────────
        return jsonify({"focused": True, "reason": "looking_down"})

    except Exception as e:
        return jsonify({"focused": True, "reason": "error", "error": str(e)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
