import os
import tensorflow as tf
import tensorflowjs as tfjs

# Configurações
MODEL_H5 = 'modelo_alpr.h5'
MODEL_KERAS = 'modelo_limpo.keras'
OUTPUT_DIR = 'tfjs_model'

def conversao_direta_v3():
    print(f"1. Carregando o modelo bruto ({MODEL_H5})...")
    try:
        # Carregamos o seu cérebro de 97.7% de acurácia
        model = tf.keras.models.load_model(MODEL_H5)
        
        print("2. Normalizando para o formato Keras 3 (.keras)...")
        # O formato .keras é muito mais estável no Python 3.13 que o .h5 ou SavedModel
        model.save(MODEL_KERAS)
        
        print("3. Convertendo para a Web (TensorFlow.js)...")
        # O conversor do TFJS agora consegue ler o formato nativo do Keras 3
        tfjs.converters.save_keras_model(model, OUTPUT_DIR)
        
        print(f"\n✅ VITÓRIA! A pasta '{OUTPUT_DIR}' foi criada com sucesso.")
        
        # Limpa o arquivo temporário
        if os.path.exists(MODEL_KERAS):
            os.remove(MODEL_KERAS)
            
    except Exception as e:
        print(f"\n❌ ERRO CRÍTICO: {e}")
        print("\nSe o erro persistir, vamos precisar de uma 'ponte' via Google Colab.")

if __name__ == "__main__":
    conversao_direta_v3()