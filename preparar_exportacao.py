import tensorflow as tf

# Lê o modelo usando o seu próprio ambiente Windows (onde o Keras 3 funciona perfeitamente)
model = tf.keras.models.load_model('treinamento_ia/modelo_alpr.h5')

# Exporta para o formato puro e imutável do TensorFlow (SavedModel)
model.export('cnn_saved_model')
print("✅ SavedModel gerado com sucesso na pasta 'cnn_saved_model'")