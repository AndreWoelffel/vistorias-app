import os
import tensorflow as tf
from tensorflow.keras import layers, models, callbacks
from tensorflow.keras.preprocessing import image_dataset_from_directory

# ==============================================================================
# CONFIGURAÇÕES DA REDE NEURAL
# ==============================================================================
DATASET_DIR = "treinamento_ia/dataset_hibrido"
TAMANHO_IMG = (64, 64)
BATCH_SIZE = 32
EPOCHS = 50 # Aumentado para 50, mas com "freio de mão" ativado

def carregar_dados():
    print("Carregando imagens e dividindo entre Treino (80%) e Validação (20%)...")
    
    treino_ds = image_dataset_from_directory(
        DATASET_DIR,
        validation_split=0.2,
        subset="training",
        seed=42,
        color_mode="grayscale",
        image_size=TAMANHO_IMG,
        batch_size=BATCH_SIZE
    )

    val_ds = image_dataset_from_directory(
        DATASET_DIR,
        validation_split=0.2,
        subset="validation",
        seed=42,
        color_mode="grayscale",
        image_size=TAMANHO_IMG,
        batch_size=BATCH_SIZE
    )
    
    return treino_ds, val_ds

def criar_modelo(num_classes):
    """Arquitetura da CNN com Data Augmentation e Dropout"""
    
    # 1. Data Augmentation: Ensina a IA a ler letras tortas, borradas ou deslocadas
    data_augmentation = tf.keras.Sequential([
        # fill_value=255.0 mantém o fundo branco ao rotacionar/mover
        layers.RandomRotation(0.1, fill_mode='constant', fill_value=255.0), 
        layers.RandomZoom(0.1, fill_mode='constant', fill_value=255.0),
        layers.RandomTranslation(0.1, 0.1, fill_mode='constant', fill_value=255.0)
    ], name="data_augmentation")

    modelo = models.Sequential([
        # Aplica a aumentação apenas durante o treino
        data_augmentation,
        
        # Normalização: converte os pixels de 0-255 para 0.0-1.0
        layers.Rescaling(1./255, input_shape=(64, 64, 1)),
        
        # 1ª Camada
        layers.Conv2D(32, 3, padding='same', activation='relu'),
        layers.MaxPooling2D(),
        
        # 2ª Camada
        layers.Conv2D(64, 3, padding='same', activation='relu'),
        layers.MaxPooling2D(),
        
        # 3ª Camada
        layers.Conv2D(128, 3, padding='same', activation='relu'),
        layers.MaxPooling2D(),
        
        layers.Flatten(),
        
        # Rede Densa de Decisão
        layers.Dense(128, activation='relu'),
        layers.Dropout(0.5), 
        
        # Camada de Saída
        layers.Dense(num_classes, activation='softmax')
    ])
    
    modelo.compile(
        optimizer='adam',
        loss='sparse_categorical_crossentropy',
        metrics=['accuracy']
    )
    return modelo

if __name__ == "__main__":
    # 1. Carregar os dados
    treino_ds, val_ds = carregar_dados()
    nomes_classes = treino_ds.class_names
    num_classes = len(nomes_classes)
    
    print(f"\nClasses detectadas: {num_classes} ({nomes_classes})")
    
    AUTOTUNE = tf.data.AUTOTUNE
    treino_ds = treino_ds.cache().shuffle(1000).prefetch(buffer_size=AUTOTUNE)
    val_ds = val_ds.cache().prefetch(buffer_size=AUTOTUNE)

    # 2. Construir Modelo
    modelo = criar_modelo(num_classes)
    
    # 3. O Freio de Mão (Early Stopping)
    # Monitora a validação. Se ficar 10 épocas sem melhorar, para e salva a melhor versão.
    early_stopping = callbacks.EarlyStopping(
        monitor='val_loss',
        patience=10,
        restore_best_weights=True,
        verbose=1
    )
    
    print(f"\nIniciando o treinamento intensivo (Máximo de {EPOCHS} épocas)...")
    historico = modelo.fit(
        treino_ds,
        validation_data=val_ds,
        epochs=EPOCHS,
        callbacks=[early_stopping] # Injetando o callback aqui
    )

    # 4. Salvar os resultados
    modelo.save("modelo_alpr.h5")
    print("\n✅ Treinamento concluído. Backup Keras salvo como 'modelo_alpr.h5'.")

    print("\nExportando para o formato nativo TensorFlow (SavedModel)...")
    modelo.export("cnn_saved_model")
    print("✅ Sucesso! A pasta 'cnn_saved_model' foi criada.")
    print("compacte esta pasta em um .zip e jogue no Google Colab para converter para a Web!")