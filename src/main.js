import './styles.css';
import { supabase } from './lib/supabase.js';
import { renderApp } from './app.js';

renderApp(document.getElementById('app'), supabase);
