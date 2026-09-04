window.addEventListener('load', () => {

    // ─── جلب عناصر الواجهة ───────────────────────────────────────────────────
    const videoElement     = document.createElement('video');
    const statusText       = document.getElementById('ai-status-text');
    const timerElement     = document.getElementById('timer-display');
    const cameraBox        = document.getElementById('camera-feed');
    const startBtn         = document.getElementById('start-btn');
    const pauseBtn         = document.getElementById('pause-btn');
    const pomodoroToggle   = document.getElementById('pomodoro-toggle');
    const pomodoroPreset   = document.getElementById('pomodoro-preset');
    const pomodoroLabel    = document.getElementById('pomodoro-phase-label');
    const placeholderText  = document.getElementById('placeholder-text');
    const sessionSummary   = document.getElementById('session-summary');
    const summaryTime      = document.getElementById('summary-time');
    const summaryDetails   = document.getElementById('summary-details');
    const statRounds       = document.getElementById('stat-rounds');
    const statTotalWork    = document.getElementById('stat-total-work');
    const statDistractions = document.getElementById('stat-distractions');
    const statFocusScore   = document.getElementById('stat-focus-score');

    // ─── ✅ الإصلاح الأساسي: URL نسبي بدل 127.0.0.1 ─────────────────────────
    // لو شغّال local → /detect_face بيروح لـ 127.0.0.1 تلقائياً
    // لو على Render   → /detect_face بيروح لـ sentinel-focus.onrender.com تلقائياً
    const BACKEND_URL = '/detect_face';

    // ─── إعدادات الكاميرا ────────────────────────────────────────────────────
    cameraBox.style.position = 'relative';
    cameraBox.style.overflow = 'hidden';
    cameraBox.style.height   = '350px';

    videoElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;';
    videoElement.setAttribute('autoplay', '');
    videoElement.setAttribute('playsinline', '');
    videoElement.setAttribute('muted', '');
    videoElement.muted = true;
    cameraBox.appendChild(videoElement);

    // ─── Canvas مصغّر 160x120 للسرعة ─────────────────────────────────────────
    const hiddenCanvas  = document.createElement('canvas');
    hiddenCanvas.width  = 160;
    hiddenCanvas.height = 120;
    const hiddenCtx     = hiddenCanvas.getContext('2d');

    statusText.style.cssText = 'position:absolute;bottom:15px;left:0;right:0;text-align:center;z-index:10;font-size:0.85rem;padding:5px;background:rgba(0,0,0,0.45);';

    // ─── زرار "أنا مركّز" ────────────────────────────────────────────────────
    const focusedBtn = document.createElement('button');
    focusedBtn.innerText = '✅ أنا مركّز يا عم';
    focusedBtn.style.cssText = 'display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;padding:14px 28px;font-size:1.1rem;font-weight:bold;background:#1a472a;color:#90EE90;border:2px solid #90EE90;border-radius:10px;cursor:pointer;box-shadow:0 0 18px rgba(144,238,144,0.45);';
    cameraBox.appendChild(focusedBtn);

    focusedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        stopAlarm();
        playFocusReturnChime();
        detectionHistory = Array(WINDOW_SECS).fill(true);
        framesSeen = framesTotal = 0;
        setStatus('FOCUSED — Sentinel Watching.', '#FAF6F0');
        cameraBox.style.outline = 'none';
        focusedBtn.style.display = 'none';
    });

    // ─── متغيرات الجلسة ──────────────────────────────────────────────────────
    let sessionActive    = false;
    let sessionPaused    = false;
    let intervalId       = null;
    let localStream      = null;
    let audioCtx         = null;
    let isFetching       = false;

    let framesSeen       = 0;
    let framesTotal      = 0;
    let detectionHistory = [];
    let lastReason       = '';

    const WINDOW_SECS  = 20;
    const ABSENT_RATIO = 0.75;
    const GRACE_PERIOD = 3;

    let sessionStartTime = null;
    let isAlertActive    = false;
    let alarmIntervalId  = null;

    let totalRounds       = 0;
    let totalFocusSeconds = 0;
    let segmentSeconds    = 0;
    let segmentDistracts  = 0;

    let pomodoroMode  = false;
    let pomodoroPhase = 'work';
    let pomodoroLeft  = 0;
    let WORK_TIME     = 25 * 60;
    let BREAK_TIME    =  5 * 60;

    // ─── helpers ─────────────────────────────────────────────────────────────
    const pad       = n => String(n).padStart(2, '0');
    const formatHMS = s => `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`;
    const formatMM  = s => `${pad(Math.floor(s/60))}:${pad(s%60)}`;
    const calcScore = (secs, distracts) =>
        secs === 0 ? 100 : Math.max(0, Math.round(100 - (distracts / (secs / 3600)) * 10));

    function setStatus(msg, color) {
        if (statusText) {
            statusText.innerText   = msg;
            statusText.style.color = color || '#FAF6F0';
        }
    }

    function setStatusByReason(reason) {
        switch (reason) {
            case 'frontal':        setStatus('👁 FOCUSED — بيبص في الشاشة',  '#FAF6F0'); break;
            case 'looking_down':   setStatus('📖 FOCUSED — بيقرأ أو بيكتب',  '#90EE90'); break;
            case 'sideways_right': setStatus('👉 تشتت! بيبص يمين',           '#FF4444'); break;
            case 'sideways_left':  setStatus('👈 تشتت! بيبص شمال',           '#FF4444'); break;
            case 'phone':          setStatus('📱 تليفون في الإطار! ركّز!',   '#FF6B00'); break;
            default:               setStatus('FOCUSED — Sentinel Watching.',  '#FAF6F0');
        }
    }

    // ─── loadPreset ──────────────────────────────────────────────────────────
    function loadPreset() {
        const parts = pomodoroPreset.value.split('-').map(Number);
        WORK_TIME  = parts[0] * 60;
        BREAK_TIME = parts[1] * 60;
    }

    function updateTimerDisplay() {
        timerElement.innerText = pomodoroMode ? formatMM(WORK_TIME) : '00:00:00';
    }

    // ─── تفعيل/إلغاء البومودورو ───────────────────────────────────────────────
    pomodoroToggle.addEventListener('change', () => {
        if (sessionActive) return;
        pomodoroMode = pomodoroToggle.checked;
        pomodoroPreset.disabled = !pomodoroMode;
        if (pomodoroMode) {
            loadPreset();
            updateTimerDisplay();
            pomodoroLabel.style.display = 'block';
            pomodoroLabel.innerText     = '💪 WORK';
            pomodoroLabel.style.color   = '#FAF6F0';
        } else {
            timerElement.innerText      = '00:00:00';
            pomodoroLabel.style.display = 'none';
        }
    });

    // ─── تغيير الـ preset: يحدّث العرض فوراً ────────────────────────────────
    pomodoroPreset.addEventListener('change', () => {
        if (sessionActive) return;
        loadPreset();
        if (pomodoroMode) updateTimerDisplay();
    });

    // ─── Audio ────────────────────────────────────────────────────────────────
    function ensureAudio() {
        if (!audioCtx) return false;
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        return audioCtx.state !== 'closed';
    }

    function beep(freq, dur, delayMs = 0) {
        if (!ensureAudio()) return;
        try {
            const t   = audioCtx.currentTime + delayMs / 1000;
            const osc = audioCtx.createOscillator();
            const g   = audioCtx.createGain();
            osc.connect(g); g.connect(audioCtx.destination);
            osc.type = 'square'; osc.frequency.value = freq;
            g.gain.setValueAtTime(0.3, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            osc.start(t); osc.stop(t + dur + 0.05);
        } catch (e) {}
    }

    function startAlarm(reason) {
        if (isAlertActive) return;
        isAlertActive = true;
        segmentDistracts++;
        statDistractions.innerText = segmentDistracts;
        focusedBtn.style.display   = 'block';
        if (reason === 'phone') {
            beep(1200,0.2,0); beep(800,0.2,200); beep(1200,0.2,400);
        } else {
            beep(880, 0.15);
        }
        alarmIntervalId = setInterval(() => {
            if (!isAlertActive) { stopAlarm(); return; }
            beep(880, 0.15);
        }, 600);
    }

    function stopAlarm() {
        isAlertActive = false;
        if (alarmIntervalId !== null) { clearInterval(alarmIntervalId); alarmIntervalId = null; }
        focusedBtn.style.display = 'none';
    }

    function playFocusReturnChime() { beep(523,0.15,0); beep(659,0.15,150); beep(784,0.25,300); }
    function playPhaseChime()       { beep(600,0.3,0);  beep(900,0.3,300); }

    // ─── إرسال الفريم للـ Backend ─────────────────────────────────────────────
    async function checkFaceWithBackend() {
        if (!sessionActive || sessionPaused) return;
        if (pomodoroMode && pomodoroPhase === 'break') return;
        if (isFetching) return;

        isFetching = true;
        hiddenCtx.drawImage(videoElement, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
        const dataUrl = hiddenCanvas.toDataURL('image/jpeg', 0.3);

        try {
            const res    = await fetch(BACKEND_URL, {   // ← URL النسبي هنا
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: dataUrl })
            });
            const result = await res.json();

            framesTotal++;
            lastReason = result.reason || '';
            if (result.focused) {
                framesSeen++;
            } else {
                setStatusByReason(result.reason);
                cameraBox.style.outline = result.reason === 'phone'
                    ? '3px solid #FF6B00'
                    : '3px solid #FF4444';
            }
        } catch (err) {
            console.error('Backend Error:', err);
            setStatus('❌ Backend Error', '#FF4444');
        } finally {
            isFetching = false;
        }
    }

    function sampleAndCheck() {
        if (!sessionActive || sessionPaused) return;

        if (pomodoroMode && pomodoroPhase === 'break') {
            framesSeen = framesTotal = 0;
            if (isAlertActive) stopAlarm();
            cameraBox.style.outline = 'none';
            return;
        }

        const elapsed = (Date.now() - sessionStartTime) / 1000;
        if (elapsed < GRACE_PERIOD) {
            framesSeen = framesTotal = 0;
            setStatus('Sentinel: Initializing...', '#FFD580');
            return;
        }

        if (framesTotal === 0) return;

        const focusedThisSec = (framesSeen / framesTotal) >= 0.20;
        framesSeen = framesTotal = 0;

        detectionHistory.push(focusedThisSec);
        if (detectionHistory.length > WINDOW_SECS) detectionHistory.shift();
        if (detectionHistory.length < WINDOW_SECS) return;

        const distractedRatio = 1 - (detectionHistory.filter(Boolean).length / WINDOW_SECS);

        if (distractedRatio >= ABSENT_RATIO) {
            if (!isAlertActive) startAlarm(lastReason);
            if (lastReason === 'phone') {
                setStatus('📱 ضع التليفون جانباً!', '#FF6B00');
                cameraBox.style.outline = '3px solid #FF6B00';
            } else {
                setStatus('⚠ تشتت! ارجع للمذاكرة!', '#FF4444');
                cameraBox.style.outline = '3px solid #FF4444';
            }
        } else {
            if (isAlertActive) { stopAlarm(); playFocusReturnChime(); }
            setStatusByReason(lastReason);
            cameraBox.style.outline = 'none';
        }
    }

    function updateTimer() {
        if (sessionPaused) return;

        checkFaceWithBackend().then(() => { sampleAndCheck(); });

        if (pomodoroMode) {
            if (pomodoroPhase === 'work') { segmentSeconds++; totalFocusSeconds++; }
            pomodoroLeft--;
            if (pomodoroLeft <= 0) { switchPhase(); return; }
            timerElement.innerText = formatMM(pomodoroLeft);
        } else {
            segmentSeconds++; totalFocusSeconds++;
            timerElement.innerText = formatHMS(segmentSeconds);
        }

        statTotalWork.innerText  = `${pad(Math.floor(totalFocusSeconds/3600))}:${pad(Math.floor((totalFocusSeconds%3600)/60))} hrs`;
        statFocusScore.innerText = `${calcScore(segmentSeconds, segmentDistracts)}%`;
    }

    function switchPhase() {
        playPhaseChime();
        if (pomodoroPhase === 'work') {
            pomodoroPhase = 'break'; pomodoroLeft = BREAK_TIME;
            pomodoroLabel.innerText   = '☕ BREAK';
            pomodoroLabel.style.color = '#90EE90';
            setStatus('☕ Break time — Relax!', '#90EE90');
            if (isAlertActive) stopAlarm();
            cameraBox.style.outline = 'none';
        } else {
            pomodoroPhase = 'work'; pomodoroLeft = WORK_TIME;
            totalRounds++;
            statRounds.innerText      = totalRounds;
            pomodoroLabel.innerText   = '💪 WORK';
            pomodoroLabel.style.color = '#FAF6F0';
            setStatus('FOCUSED — Sentinel Watching.', '#FAF6F0');
            resetDetection();
        }
        timerElement.innerText = formatMM(pomodoroLeft);
    }

    function resetDetection() {
        framesSeen = framesTotal = 0;
        detectionHistory = Array(WINDOW_SECS).fill(true);
        sessionStartTime = Date.now();
        isFetching = false;
        lastReason = '';
    }

    pauseBtn.addEventListener('click', () => {
        if (!sessionActive) return;
        sessionPaused = !sessionPaused;
        if (sessionPaused) {
            if (isAlertActive) stopAlarm();
            resetDetection();
            cameraBox.style.outline = 'none';
            setStatus('⏸ Paused — Session on hold.', '#FFD580');
            pauseBtn.innerText = 'RESUME';
        } else {
            resetDetection();
            setStatus('Sentinel: Watching...', '#FAF6F0');
            pauseBtn.innerText = 'PAUSE';
        }
    });

    startBtn.addEventListener('click', () => {
        if (!sessionActive) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
                .then(stream => {
                    localStream = stream;
                    videoElement.srcObject = stream;
                    videoElement.play();

                    pomodoroMode = pomodoroToggle.checked;

                    if (pomodoroMode) {
                        loadPreset();
                        pomodoroPhase = 'work';         // ← دايماً يبدأ بـ WORK
                        pomodoroLeft  = WORK_TIME;      // ← الوقت الكامل من الأول
                        timerElement.innerText      = formatMM(WORK_TIME);
                        pomodoroLabel.style.display = 'block';
                        pomodoroLabel.innerText     = '💪 WORK';
                        pomodoroLabel.style.color   = '#FAF6F0';
                    } else {
                        pomodoroPhase          = 'work';
                        timerElement.innerText = '00:00:00';
                    }

                    sessionActive = true;
                    sessionPaused = false;
                    if (sessionSummary) sessionSummary.style.display = 'none';

                    segmentSeconds = 0; segmentDistracts = 0;
                    statDistractions.innerText = '0';
                    resetDetection();

                    intervalId = setInterval(updateTimer, 1000);

                    startBtn.innerText = 'END SESSION';
                    pauseBtn.style.display  = 'inline-block';
                    pomodoroToggle.disabled = true;
                    pomodoroPreset.disabled = true;
                    if (placeholderText) placeholderText.style.display = 'none';
                    setStatus('Sentinel: Initializing...', '#FFD580');
                })
                .catch(err => {
                    console.error('Camera access blocked:', err);
                    alert('يرجى السماح بالوصول إلى الكاميرا لتشغيل النظام.');
                });

        } else {
            sessionActive = false;
            clearInterval(intervalId);
            if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
            stopAlarm();
            resetDetection();

            if (summaryTime) {
                summaryTime.innerText    = formatHMS(segmentSeconds);
                summaryDetails.innerText = `${segmentDistracts} distractions • Focus Score: ${calcScore(segmentSeconds, segmentDistracts)}%`;
                sessionSummary.style.display = 'block';
            }

            startBtn.innerText = 'START SESSION';
            pauseBtn.style.display  = 'none';
            pomodoroToggle.disabled = false;
            pomodoroPreset.disabled = !pomodoroMode;
            cameraBox.style.outline = 'none';
            updateTimerDisplay();
            setStatus('Sentinel Standby...', '#FAF6F0');
        }
    });
});