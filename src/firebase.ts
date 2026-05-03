import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// User provided config
const firebaseConfig = {
  apiKey: "AIzaSyBwYmYnB9OI6jiTkYLhVRZcXs4xc15dxJs",
  authDomain: "messingappworld.firebaseapp.com",
  databaseURL: "https://messingappworld-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "messingappworld",
  storageBucket: "messingappworld.firebasestorage.app",
  messagingSenderId: "562121777479",
  appId: "1:562121777479:web:7e236014a8fc4b0a38ac62"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
