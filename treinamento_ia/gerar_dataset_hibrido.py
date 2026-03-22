import os
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import random

# Configurações de Engenharia
FONTS = ["FE-FONT.TTF", "Mandatory.otf"] # As duas fontes que você tem
CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
OUTPUT_DIR = "dataset_hibrido"
IMG_SIZE = 64 # O tamanho que o seu App espera

def apply_distortions(img_np):
    # 1. Rotação aleatória (até 15 graus)
    rows, cols = img_np.shape
    angle = random.uniform(-15, 15)
    M = cv2.getRotationMatrix2D((cols/2, rows/2), angle, 1)
    img_np = cv2.warpAffine(img_np, M, (cols, rows), borderValue=255)
    
    # 2. Desfoque (Motion Blur ou Gaussiano)
    if random.random() > 0.5:
        img_np = cv2.GaussianBlur(img_np, (3, 3), 0)
        
    # 3. Ruído (Simular granulação da câmera)
    noise = np.random.randint(0, 50, (IMG_SIZE, IMG_SIZE), dtype='uint8')
    img_np = cv2.add(img_np, noise)
    
    return img_np

def generate_dataset(samples_per_char=500):
    if not os.path.exists(OUTPUT_DIR): os.makedirs(OUTPUT_DIR)
    
    print(f"Gerando {samples_per_char * len(CHARS)} imagens para o TCC...")
    
    for char in CHARS:
        char_dir = os.path.join(OUTPUT_DIR, char)
        if not os.path.exists(char_dir): os.makedirs(char_dir)
        
        for i in range(samples_per_char):
            # Escolhe uma fonte aleatória (Mercosul ou Antiga)
            font_path = random.choice(FONTS)
            img = Image.new('L', (IMG_SIZE, IMG_SIZE), color=255)
            draw = ImageDraw.Draw(img)
            
            # Tenta carregar a fonte, se falhar usa a padrão
            try:
                font = ImageFont.truetype(font_path, 50)
            except:
                font = ImageFont.load_default()
            
            # Centraliza o caractere
            # O método moderno calcula a caixa delimitadora (bounding box) do texto
            bbox = draw.textbbox((0, 0), char, font=font)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            draw.text(((IMG_SIZE-w)/2, (IMG_SIZE-h)/2), char, font=font, fill=0)
            
            # Aplica distorções de mundo real
            img_np = apply_distortions(np.array(img))
            
            cv2.imwrite(os.path.join(char_dir, f"{char}_{i}.png"), img_np)

if __name__ == "__main__":
    generate_dataset()