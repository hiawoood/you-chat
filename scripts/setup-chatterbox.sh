#!/bin/bash
# Chatterbox Turbo TTS Setup Script for Vast.ai
# This script sets up a complete TTS server on a fresh Vast.ai instance
# Usage: curl -fsSL https://raw.githubusercontent.com/hiawoood/you-chat/main/scripts/setup-chatterbox.sh | bash

set -e

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "=========================================="
log "Chatterbox Turbo TTS Server Setup"
log "=========================================="
log ""

cd /root

# Update system
log "[1/6] Updating system packages..."
apt-get update -qq
apt-get install -y -qq python3-pip ffmpeg git curl vim

# Install PyTorch with CUDA
log "[2/6] Installing PyTorch with CUDA..."
pip install -q --upgrade pip
pip install -q torch==2.6.0 torchvision==0.21.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124

# Install FastAPI and dependencies
log "[3/6] Installing FastAPI and dependencies..."
pip install -q fastapi uvicorn python-dotenv python-multipart requests psutil numpy scipy soundfile transformers accelerate

# Install Chatterbox TTS
log "[4/6] Installing Chatterbox TTS (this takes 2-3 minutes)..."
pip install -q chatterbox-tts

# Create the TTS server
log "[5/6] Creating TTS server..."
cat > /root/tts_server.py << 'PYEOF'
import os
import io
import base64
import torch
import torchaudio as ta
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Literal
import uvicorn

app = FastAPI(
    title="Chatterbox Turbo TTS Server",
    description="Fast TTS server for Vast.ai",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
device = None

class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = "default"
    speed: Optional[float] = 1.0
    format: Optional[Literal["mp3", "wav", "ogg"]] = "mp3"

class TTSResponse(BaseModel):
    success: bool
    audio: str
    duration: float
    sample_rate: int

@app.on_event("startup")
async def load_model():
    global model, device
    log("Loading Chatterbox Turbo model...")
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"Using device: {device}")
    try:
        model = ChatterboxTurboTTS.from_pretrained(device=device)
        log("✓ Model loaded successfully!")
    except Exception as e:
        log(f"Error loading model: {e}")
        raise

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "model_loaded": model is not None,
        "device": device
    }

@app.get("/")
async def root():
    return {
        "message": "Chatterbox Turbo TTS Server",
        "version": "1.0.0",
        "endpoints": {
            "health": "/health",
            "tts": "/v1/audio/speech (POST)"
        }
    }

@app.post("/v1/audio/speech", response_model=TTSResponse)
async def text_to_speech(request: TTSRequest):
    global model
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")
    if not request.text or len(request.text.strip()) == 0:
        raise HTTPException(status_code=400, detail="Text is required")
    
    try:
        log(f"Generating: {request.text[:50]}...")
        wav = model.generate(request.text)
        duration = wav.shape[-1] / model.sr
        
        buffer = io.BytesIO()
        if request.format == "mp3":
            ta.save(buffer, wav, model.sr, format="mp3")
        elif request.format == "ogg":
            ta.save(buffer, wav, model.sr, format="ogg")
        else:
            ta.save(buffer, wav, model.sr, format="wav")
        
        buffer.seek(0)
        audio_bytes = buffer.read()
        audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
        
        log(f"✓ Generated {duration:.2f}s of audio")
        return TTSResponse(
            success=True,
            audio=audio_base64,
            duration=duration,
            sample_rate=model.sr
        )
    except Exception as e:
        log(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    log(f"Starting server on port {port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)
PYEOF

# Create start script
log "[6/6] Creating start script..."
cat > /root/start_tts.sh << 'EOF'
#!/bin/bash
cd /root
source /root/.bashrc 2>/dev/null || true
python3 /root/tts_server.py
EOF
chmod +x /root/start_tts.sh

log ""
log "=========================================="
log "Setup Complete!"
log "=========================================="
log ""
log "To start the TTS server, run:"
log "  /root/start_tts.sh"
log ""
log "Or directly:"
log "  python3 /root/tts_server.py"
log ""
log "The server will start on port 8000"
log ""
log "Test it with:"
log "  curl http://localhost:8000/health"
log ""

# Auto-start the server
log "Auto-starting TTS server..."
nohup /root/start_tts.sh > /var/log/tts-server.log 2>&1 &
sleep 2
log "Server started! Check logs: tail -f /var/log/tts-server.log"
