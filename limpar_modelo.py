import tensorflow as tf

print("Carregando o modelo vitorioso...")
# 1. Carrega o modelo que você acabou de treinar
modelo_treinado = tf.keras.models.load_model('modelo_alpr.h5')

# 2. Faz a cirurgia: Pega todas as camadas, EXCETO a primeira (índice 0, que é o Data Augmentation)
camadas_limpas = modelo_treinado.layers[1:]

# 3. Cria um novo modelo apenas com o cérebro limpo
modelo_limpo = tf.keras.Sequential(camadas_limpas)

# 4. Avisa o modelo o tamanho exato da foto que ele vai receber
modelo_limpo.build((None, 64, 64, 1))

# 5. Salva no formato puro do TensorFlow
print("Exportando modelo limpo...")
modelo_limpo.export('cnn_saved_model_limpo')
print("✅ Sucesso! A pasta 'cnn_saved_model_limpo' foi gerada sem as mutações.")