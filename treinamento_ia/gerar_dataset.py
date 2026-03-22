import os
import random
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

# ==============================================================================
# CONFIGURAÇÕES DO ENGENHEIRO
# ==============================================================================
CARACTERES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

# Nomes exatos conforme os arquivos baixados
FONTE_MERCOSUL = "FE-FONT.TTF" 
FONTE_ANTIGA = "Mandatory.otf"

OUTPUT_DIR = "dataset_caracteres"
TAMANHO_IMG = (64, 64)
EXEMPLOS_POR_CLASSE = 300 # Total de ~10.800 imagens (300 de cada letra/número)

def aplicar_distorcao(img_pil):
    """Simula as condições reais do pátio do Detran (Ângulo, Luz e Ruído)"""
    # Converte a imagem do formato PIL para o formato OpenCV (Matriz NumPy)
    img = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2GRAY)
    
    # 1. Rotação aleatória (Trata o problema da foto inclinada)
    angulo = random.uniform(-15, 15)
    M = cv2.getRotationMatrix2D((32, 32), angulo, 1.0)
    img = cv2.warpAffine(img, M, TAMANHO_IMG, borderValue=255)
    
    # 2. Ruído Gaussiano (Simula granulação da câmera/baixa luz)
    ruido = np.random.normal(0, 15, img.shape).astype(np.uint8)
    img = cv2.add(img, ruido)
    
    # 3. Desfoque (Simula trepidação do celular ou falta de foco)
    if random.random() > 0.5:
        k = random.choice([3, 5])
        img = cv2.GaussianBlur(img, (k, k), 0)
        
    return img

def gerar_dataset():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    try:
        # A biblioteca lê perfeitamente tanto .ttf quanto .otf
        fontes = [
            ImageFont.truetype(FONTE_MERCOSUL, 50),
            ImageFont.truetype(FONTE_ANTIGA, 50)
        ]
    except Exception as e:
        print(f"ERRO: Não foi possível carregar as fontes. Verifique se os arquivos estão na mesma pasta do script. Detalhe: {e}")
        return

    print(f"Gerando dataset em '{OUTPUT_DIR}'...")
    
    for char in CARACTERES:
        char_dir = os.path.join(OUTPUT_DIR, char)
        if not os.path.exists(char_dir):
            os.makedirs(char_dir)
            
        for i in range(EXEMPLOS_POR_CLASSE):
            # Escolhe aleatoriamente se vai usar a fonte Mercosul ou a Antiga
            fonte_atual = random.choice(fontes)
            
            # Cria imagem branca
            img_pil = Image.new('RGB', TAMANHO_IMG, color=(255, 255, 255))
            draw = ImageDraw.Draw(img_pil)
            
            # Centraliza o caractere (Método moderno do Pillow)
            bbox = draw.textbbox((0, 0), char, font=fonte_atual)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            
            x = (TAMANHO_IMG[0] - w) / 2 - bbox[0]
            y = (TAMANHO_IMG[1] - h) / 2 - bbox[1]
            
            draw.text((x, y), char, font=fonte_atual, fill=(0, 0, 0))
            
            # Aplica distorções de "Mundo Real"
            img_final = aplicar_distorcao(img_pil)
            
            # Salva a imagem na subpasta da letra correspondente
            filename = f"{char}_{i}.png"
            cv2.imwrite(os.path.join(char_dir, filename), img_final)
            
        print(f"Classe [{char}] concluída.")

if __name__ == "__main__":
    gerar_dataset()
    print("\n✅ Dataset pronto para o treinamento da Rede Neural!")