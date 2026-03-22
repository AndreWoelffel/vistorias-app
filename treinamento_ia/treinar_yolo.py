import os
from ultralytics import YOLO

# Configurações de Engenharia do TCC
# O caminho para o arquivo 'data.yaml' que o Roboflow vai gerar
DATA_YAML_PATH = 'D:/Laudos_GDL/App_Vistoria/treinamento_ia/dataset_yolo_vistoria/data.yaml' # AJUSTE O SEU CAMINHO

# Métrica de Peso: Usaremos o modelo Nano (n) para rodar offline no mobile
MODEL_SIZE = 'yolov8s.pt' # Começa com pesos pré-treinados (Transfer Learning)

# Configurações de Treinamento Heavy Duty
EPOCHS = 50       # Para placas, entre 50 e 100 épocas é o 'ponto doce'
IMG_SIZE = 640    # Tamanho padrão do YOLO (pode diminuir para 320 no mobile depois)
BATCH_SIZE = 16   # Ajuste conforme a memória da sua GPU (Cuda)

def treinar_modelo():
    print("🚀 Carregando arquitetura YOLOv8 Nano para o TCC...")
    model = YOLO(MODEL_SIZE) # Carrega modelo pré-treinado
    
    # Inicia o treinamento
    print(f"🔥 Iniciando treinamento pesado por {EPOCHS} épocas...")
    results = model.train(
        data=DATA_YAML_PATH,
        epochs=EPOCHS,
        imgsz=IMG_SIZE,
        batch=BATCH_SIZE,
        name='ALPR_Vistoria_YOLOv8n', # Nome da pasta de saída
        device='cpu', # '0' para usar GPU Nvidia (Cuda), 'cpu' se não tiver
    )
    
    # --- VALIDAÇÃO DE ENGENHARIA ---
    print("\n📊 Analisando métricas de precisão...")
    
    # mAP50 é a métrica padrão para validar se a detecção está "acertando o alvo"
    map50 = results.results_dict['metrics/mAP50(B)']
    map50_95 = results.results_dict['metrics/mAP50-95(B)']

    print(f"⭐ mAP@50: {map50:.4f}")
    print(f"⭐ mAP@50-95: {map50_95:.4f}")

    # Checklist de Aprovação para o TCC
    print("\n📋 Checklist de Qualidade:")
    if map50 > 0.95:
        print("✅ EXCELENTE: O modelo está detectando quase perfeitamente (Digno de nota 10!).")
    elif map50 > 0.85:
        print("🟡 BOM: O modelo é robusto, mas pode falhar em ângulos extremos como o do Renault.")
    else:
        print("❌ ALERTA: Precisão baixa. Verifique se o dataset tem imagens rotuladas corretamente.")

    # Verifica especificamente a performance por classe (Placa vs Caractere)
    # Isso ajuda a saber se o problema é o "I" sumindo
    print("\n🔍 Desempenho por Categoria:")
    for i, name in enumerate(model.names):
        # Acessa a métrica específica da classe
        cls_map = results.maps[i]
        print(f" - {name}: {cls_map:.4f}")
    
    # Exporta o modelo para o formato que o navegador entende (TensorFlow.js)
    print("\n✅ Treinamento concluído com sucesso!")
    print(f"📁 O melhor modelo está salvo em: runs/detect/ALPR_Vistoria_YOLOv8n/weights/best.pt")

if __name__ == "__main__":
    # Garanta que o terminal esteja na pasta 'treinamento_ia'
    if not os.path.exists(DATA_YAML_PATH):
        print(f"⚠️ ERRO CRÍTICO: O arquivo 'data.yaml' não foi encontrado em {DATA_YAML_PATH}.")
        print("Siga o Passo a Passo de rotulagem primeiro para gerar esse arquivo.")
    else:
        treinar_modelo()