// ====================================================
// SISTEMA DE MODAIS PERSONALIZADOS
// ====================================================

class Modal {
  static show(options) {
    const { title, content, buttons = [], onClose } = options;
    
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'custom-modal';
    
    overlay.innerHTML = `
      <div class="modal-content p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-xl font-bold text-gray-800 dark:text-gray-100">${title}</h3>
          <button onclick="Modal.close()" class="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <i class="fas fa-times text-xl"></i>
          </button>
        </div>
        <div class="text-gray-600 dark:text-gray-300 mb-6">
          ${content}
        </div>
        <div class="flex gap-3 justify-end">
          ${buttons.map(btn => `
            <button
              onclick="${btn.onClick}"
              class="${btn.className || 'bg-gray-200 hover:bg-gray-300'} px-4 py-2 rounded-lg font-semibold transition"
            >
              ${btn.text}
            </button>
          `).join('')}
        </div>
      </div>
    `;
    
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        Modal.close();
        if (onClose) onClose();
      }
    };
    
    document.body.appendChild(overlay);
    return overlay;
  }
  
  static close() {
    const modal = document.getElementById('custom-modal');
    if (modal) {
      modal.remove();
    }
  }
  
  static confirm(title, message, onConfirm, onCancel) {
    return Modal.show({
      title,
      content: `<p>${message}</p>`,
      buttons: [
        {
          text: 'Cancelar',
          className: 'bg-gray-200 hover:bg-gray-300 text-gray-800',
          onClick: `Modal.close(); ${onCancel ? `(${onCancel})()` : ''}`
        },
        {
          text: 'Confirmar',
          className: 'bg-indigo-600 hover:bg-indigo-700 text-white',
          onClick: `Modal.close(); (${onConfirm})()`
        }
      ]
    });
  }
  
  static input(title, placeholder, onSubmit) {
    const inputId = 'modal-input-' + Date.now();
    const modal = Modal.show({
      title,
      content: `
        <input
          type="text"
          id="${inputId}"
          placeholder="${placeholder}"
          class="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent dark:bg-gray-700 dark:text-white"
        />
      `,
      buttons: [
        {
          text: 'Cancelar',
          className: 'bg-gray-200 hover:bg-gray-300 text-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white',
          onClick: 'Modal.close()'
        },
        {
          text: 'Confirmar',
          className: 'bg-indigo-600 hover:bg-indigo-700 text-white',
          onClick: `Modal.submitInput('${inputId}', ${onSubmit})`
        }
      ]
    });
    
    setTimeout(() => {
      const input = document.getElementById(inputId);
      if (input) {
        input.focus();
        input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            Modal.submitInput(inputId, onSubmit);
          }
        });
      }
    }, 100);
    
    return modal;
  }
  
  static submitInput(inputId, callback) {
    const input = document.getElementById(inputId);
    if (input && input.value.trim()) {
      const value = input.value.trim();
      Modal.close();
      if (callback) callback(value);
    }
  }
  
  static multiInput(title, fields, onSubmit) {
    const fieldsHtml = fields.map(field => `
      <div class="mb-4">
        <label class="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          ${field.label}
        </label>
        <input
          type="${field.type || 'text'}"
          id="modal-field-${field.name}"
          placeholder="${field.placeholder || ''}"
          value="${field.value || ''}"
          class="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent dark:bg-gray-700 dark:text-white"
        />
      </div>
    `).join('');
    
    Modal.show({
      title,
      content: fieldsHtml,
      buttons: [
        {
          text: 'Cancelar',
          className: 'bg-gray-200 hover:bg-gray-300 text-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white',
          onClick: 'Modal.close()'
        },
        {
          text: 'Salvar',
          className: 'bg-indigo-600 hover:bg-indigo-700 text-white',
          onClick: `Modal.submitMultiInput(${JSON.stringify(fields.map(f => f.name))}, ${onSubmit})`
        }
      ]
    });
  }
  
  static submitMultiInput(fieldNames, callback) {
    const values = {};
    for (const name of fieldNames) {
      const input = document.getElementById(`modal-field-${name}`);
      if (input) {
        values[name] = input.value;
      }
    }
    Modal.close();
    if (callback) callback(values);
  }
  
  static alert(title, message, type = 'info') {
    const icons = {
      success: '<i class="fas fa-check-circle text-5xl text-green-500 mb-4"></i>',
      error: '<i class="fas fa-times-circle text-5xl text-red-500 mb-4"></i>',
      warning: '<i class="fas fa-exclamation-triangle text-5xl text-yellow-500 mb-4"></i>',
      info: '<i class="fas fa-info-circle text-5xl text-blue-500 mb-4"></i>'
    };
    
    return Modal.show({
      title,
      content: `
        <div class="text-center">
          ${icons[type] || icons.info}
          <p>${message}</p>
        </div>
      `,
      buttons: [
        {
          text: 'OK',
          className: 'bg-indigo-600 hover:bg-indigo-700 text-white',
          onClick: 'Modal.close()'
        }
      ]
    });
  }
}

// Disponibilizar globalmente
window.Modal = Modal;

// ====================================================
// SISTEMA DE TEMA CLARO/ESCURO
// ====================================================

class ThemeManager {
  static init() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    this.setTheme(savedTheme);
    this.createToggle();
  }
  
  static setTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }
  
  static toggle() {
    const isDark = document.documentElement.classList.contains('dark');
    this.setTheme(isDark ? 'light' : 'dark');
  }
  
  static createToggle() {
    // Remover toggle existente se houver
    const existing = document.getElementById('theme-toggle-btn');
    if (existing) existing.remove();
    
    const toggle = document.createElement('button');
    toggle.id = 'theme-toggle-btn';
    toggle.className = 'theme-toggle';
    toggle.onclick = () => this.toggle();
    
    const isDark = document.documentElement.classList.contains('dark');
    toggle.innerHTML = `
      <i class="fas fa-${isDark ? 'sun' : 'moon'} text-xl text-gray-700 dark:text-yellow-300"></i>
    `;
    
    // Adicionar ao body quando o DOM estiver pronto
    if (document.body) {
      document.body.appendChild(toggle);
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(toggle);
      });
    }
    
    // Atualizar ícone ao alternar tema
    const updateIcon = () => {
      const isDark = document.documentElement.classList.contains('dark');
      toggle.innerHTML = `
        <i class="fas fa-${isDark ? 'sun' : 'moon'} text-xl text-gray-700 dark:text-yellow-300"></i>
      `;
    };
    
    toggle.addEventListener('click', () => setTimeout(updateIcon, 50));
  }
}

// Inicializar tema
ThemeManager.init();
window.ThemeManager = ThemeManager;

// ====================================================
// UTILITÁRIOS
// ====================================================

// Toast notifications
window.showToast = function(message, type = 'info') {
  const toast = document.createElement('div');
  const colors = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    warning: 'bg-yellow-500',
    info: 'bg-blue-500'
  };
  
  toast.className = `fixed bottom-4 right-4 ${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-fade-in`;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
};
