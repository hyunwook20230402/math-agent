import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

document.title = '수학 학원 학생';

createRoot(document.getElementById("root")!).render(<App />);
