import os
import shutil
from ultralytics import YOLO

# ==========================================
# CONFIGURAÇÕES DO ARQUITETO
# ==========================================
# Caminho do modelo que você acabou de treinar (o seu 'best.pt')
MODELO_PATH = 'D:/Laudos_GDL/App_Vistoria/treinamento_ia/runs/detect/ALPR_Vistoria_YOLOv8n3/weights/best.pt' # Ajuste se necessário

PASTA_IMAGENS_CRUAS = 'D:/Laudos_GDL/App_Vistoria/treinamento_ia/imagens_cruas'
PASTA_SAIDA = 'D:/Laudos_GDL/App_Vistoria/treinamento_ia/dataset_pre_anotado'

def executar_pseudo_labeling():
    print("🚀 Iniciando Motor de Pseudo-Labeling...")
    
    # 1. Prepara a pasta de saída
    if not os.path.exists(PASTA_SAIDA):
        os.makedirs(PASTA_SAIDA)
        
    # 2. Carrega a sua Inteligência Artificial atual
    model = YOLO(MODELO_PATH)
    
    arquivos = [f for f in os.listdir(PASTA_IMAGENS_CRUAS) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
    print(f"📸 Encontradas {len(arquivos)} imagens sem rótulo. Trabalhando...")

    for img_nome in arquivos:
        img_path = os.path.join(PASTA_IMAGENS_CRUAS, img_nome)
        
        # O YOLO analisa a imagem (conf=0.25 para tentar pegar as letras difíceis)
        resultados = model(img_path, conf=0.25, verbose=False)
        
        # Prepara o arquivo .txt com o mesmo nome da imagem
        txt_nome = os.path.splitext(img_nome)[0] + '.txt'
        txt_path = os.path.join(PASTA_SAIDA, txt_nome)
        
        # Extrai as caixas e salva no padrão YOLO
        with open(txt_path, 'w') as f:
            for box in resultados[0].boxes:
                # box.xywhn retorna [centro_x, centro_y, largura, altura] normalizados (0.0 a 1.0)
                coords = box.xywhn[0].tolist()
                classe_id = int(box.cls[0].item()) # 0 para Caractere, 1 para Placa
                
                # Escreve a linha: "ID_CLASSE X Y W H"
                linha = f"{classe_id} {coords[0]:.6f} {coords[1]:.6f} {coords[2]:.6f} {coords[3]:.6f}\n"
                f.write(linha)
                
        # Copia a imagem original para a pasta de saída para o Roboflow não chiar
        shutil.copy(img_path, os.path.join(PASTA_SAIDA, img_nome))

    print(f"\n✅ Concluído! O seu modelo pré-anotou {len(arquivos)} imagens.")
    print(f"📁 Veja a pasta '{PASTA_SAIDA}'. Suba os pares de .jpg e .txt juntos no Roboflow!")

if __name__ == "__main__":
    if not os.path.exists(PASTA_IMAGENS_CRUAS):
        print(f"⚠️ Crie a pasta '{PASTA_IMAGENS_CRUAS}' e coloque algumas fotos lá primeiro.")
    else:
        executar_pseudo_labeling()