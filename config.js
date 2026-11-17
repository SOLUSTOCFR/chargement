// Réglages de l'appli — à modifier ici, sans toucher au reste.
window.APP_CONFIG = {
  // Adresse du relais Google (Apps Script) : à coller après le déploiement.
  // Tant qu'elle est vide, l'appli fonctionne en local sur le téléphone, sans envoi vers le Drive.
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyQkBtajCcznLPNuLNs4g5fn0WjPW5EwJt-5n_TrB_jJctlcC9yhGj3LJmhPvnL--pc7A/exec",

  // Ce dépôt est PUBLIC : aucun nom de client, de fournisseur ou de marque ne doit figurer dans ces fichiers.
  MAX_PHOTOS: 12,       // photos par palette (palette + toutes les pages du BL)
  PHOTO_MAX_SIDE: 1600, // taille max d'une photo en pixels (plus grand côté)
  PHOTO_QUALITY: 0.72   // qualité JPEG (0 à 1)
};
