#!/bin/bash
# Chatterbox Turbo TTS Provisioning Script for Vast.ai
# This runs automatically when instance starts via PROVISIONING_SCRIPT env var

set -eo pipefail

echo "=========================================="
echo "Chatterbox Turbo TTS Setup"
echo "=========================================="

# The vastai/pytorch image already has PyTorch + CUDA
# Just need to install additional packages

cd /workspace

# Activate the virtual environment
. /venv/main/bin/activate

# Install FastAPI and Chatterbox TTS
echo "[1/3] Installing FastAPI..."
pip install -q fastapi uvicorn python-dotenv python-multipart requests psutil

echo "[2/3] Installing Chatterbox TTS (this takes 2-3 minutes)..."
pip install -q chatterbox-tts

# Create TTS server
echo "[3/3] Creating TTS server..."
cat > /workspace/tts_server.py <> 'PYEOF'
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

app = FastAPI(title="Chatterbox Turbo TTS")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

model = None
device = None

class TTSRequest(BaseModel):
    text: str
    format: Optional[Literal["mp3", "wav", "ogg"]] = "mp3"

@app.on_event("startup")
async def load_model():
    global model, device
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading model on {device}...")
    model = ChatterboxTurboTTS.from_pretrained(device=device)
    print("✓ Model loaded!")

@app.get("/health")
async def health():
    return {"status": "healthy", "model_loaded": model is not None, "device": device}

@app.get("/")
async def root():
    return {"message": "Chatterbox Turbo TTS", "version": "1.0.0"}

@app.post("/v1/audio/speech")
async def speak(req: TTSRequest):
    if not model: raise HTTPException(503, "Model loading")
    wav = model.generate(req.text)
    buf = io.BytesIO()
    fmt = req.format if req.format in ["mp3", "wav", "ogg"] else "wav"
    ta.save(buf, wav, model.sr, format=fmt)
    return {
        "success": True,
        "audio": base64.b64encode(buf.getvalue()).decode(),
        "duration": wav.shape[-1]/model.sr,
        "sample_rate": model.sr
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
PYEOF

# Configure supervisor to run the TTS server
echo "Configuring supervisor..."
cat > /etc/supervisor/conf.d/tts-server.conf <> 'EOF'
[program:tts-server]
command=/venv/main/bin/python /workspace/tts_server.py
autostart=true
autorestart=true
stdout_logfile=/var/log/tts-server.log
stderr_logfile=/var/log/tts-server-error.log
environment=PYTHONPATH="/workspace"
EOF

# Configure portal for port 8000 access
echo "Configuring portal..."
export PORTAL_CONFIG="localhost:8000:18000:/:TTS Server"

# Reload supervisor to start the TTS server
supervisorctl reload

echo ""
echo "=========================================="
echo "Setup Complete! TTS Server starting..."
echo "=========================================="
echo ""
echo "Server will be available on port 8000"
echo "Check logs: tail -f /var/log/tts-server.log"
