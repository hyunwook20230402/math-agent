import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './print.css'

document.title = '수학 학원 선생님';

createRoot(document.getElementById("root")!).render(<App />);
