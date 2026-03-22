from ultralytics import YOLO

# 1. Carrega o nosso modelo campeão
caminho_modelo = 'runs/detect/ALPR_Vistoria_YOLOv8n/weights/best.pt'
print(f"🚀 Carregando o modelo treinado: {caminho_modelo}")
model = YOLO(caminho_modelo)

# 2. Exporta para o formato que o navegador entende (TensorFlow.js)
print("⚙️ Convertendo o cérebro para formato Web (tfjs)...")
# Essa função vai criar uma pasta contendo o model.json e os arquivos .bin
model.export(format='tfjs')

print("✅ Exportação concluída! Verifique a pasta gerada.")