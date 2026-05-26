/* ============================================================
   JAVASCRIPT für ECHTES iOS Liquid Glass
   ============================================================
   
   - Progressive Blur on Scroll
   - iOS Haptic Feedback
   - Spring Animations
   - Safe Area Detection
   
============================================================ */

// ===== PROGRESSIVE BLUR ON SCROLL =====
// Macht den Dock blur stärker wenn man scrollt
(function initLiquidGlassScroll() {
  const dock = document.getElementById('bottomDock');
  const appView = document.querySelector('.app-view.visible');
  
  if (!dock || !appView) return;
  
  let scrollTimeout;
  
  appView.addEventListener('scroll', () => {
    // Wenn scrolling, aktiviere enhanced blur
    document.body.classList.add('dock-scroll-active');
    
    // Haptic Feedback (optional)
    if (navigator.vibrate) {
      navigator.vibrate(8); // 8ms light haptic
    }
    
    // Clear timeout wenn noch am scrolling
    clearTimeout(scrollTimeout);
    
    // Nach dem Scroll: reduce blur wieder
    scrollTimeout = setTimeout(() => {
      document.body.classList.remove('dock-scroll-active');
    }, 400);
  }, { passive: true });
})();

// ===== DOCK BUTTON INTERACTIONS =====
(function initDockInteractions() {
  const dockButtons = document.querySelectorAll('.dock-btn');
  
  dockButtons.forEach(btn => {
    // Click Handler mit Haptic Feedback
    btn.addEventListener('click', (e) => {
      // Haptic Feedback on iOS
      if (navigator.vibrate) {
        navigator.vibrate([15, 10, 15]); // Click haptic pattern
      }
      
      // Scale Animation
      btn.style.transform = 'scale(0.92)';
      setTimeout(() => {
        btn.style.transform = '';
      }, 150);
    });
    
    // Touch Start — für zusätzliches Feedback
    btn.addEventListener('touchstart', () => {
      if (navigator.vibrate) {
        navigator.vibrate(10);
      }
    }, { passive: true });
  });
})();

// ===== SAFE AREA DETECTION =====
// Für iPhone X+ mit Notch
(function detectSafeArea() {
  const safeBottom = getComputedStyle(document.documentElement)
    .getPropertyValue('--safe-bottom');
  
  if (safeBottom && safeBottom !== '0px') {
    document.documentElement.setAttribute('data-has-notch', 'true');
  }
})();

// ===== DOCK INDICATOR SPRING ANIMATION =====
// Falls JS die Position updatet
function animateDockIndicator(targetX) {
  const indicator = document.getElementById('dockIndicator');
  if (!indicator) return;
  
  // Spring Parameter
  const springConfig = {
    tension: 280,
    friction: 60,
    mass: 1
  };
  
  // Simple Spring Simulation
  let currentX = 0;
  let velocity = 0;
  
  function step() {
    const diff = targetX - currentX;
    const force = diff * (springConfig.tension / 100);
    
    velocity += force;
    velocity *= (1 - springConfig.friction / 100);
    currentX += velocity;
    
    indicator.style.transform = `translateX(${currentX}px)`;
    
    if (Math.abs(velocity) > 0.1 || Math.abs(diff) > 0.1) {
      requestAnimationFrame(step);
    }
  }
  
  step();
}

// ===== iOS-like PULL-TO-REFRESH Style =====
// (Optional - wenn gewünscht)
(function initPullToRefresh() {
  const appView = document.querySelector('.app-view.visible');
  if (!appView) return;
  
  let startY = 0;
  let isDragging = false;
  
  appView.addEventListener('touchstart', (e) => {
    if (appView.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      isDragging = true;
    }
  }, { passive: true });
  
  appView.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    
    const currentY = e.touches[0].clientY;
    const diff = currentY - startY;
    
    // Wenn man nach unten zieht und ganz oben ist
    if (diff > 0 && appView.scrollTop === 0) {
      // Optional: Add pull-down visual feedback
    }
  }, { passive: true });
  
  appView.addEventListener('touchend', () => {
    isDragging = false;
  });
})();

// ===== ORIENTATION CHANGE =====
// Safe Area kann sich ändern wenn gedreht
window.addEventListener('orientationchange', () => {
  // Dock Position neu berechnen
  const dock = document.getElementById('bottomDock');
  if (dock) {
    // Force Reflow
    dock.style.display = 'none';
    setTimeout(() => {
      dock.style.display = '';
    }, 50);
  }
}, { passive: true });

// ===== DARK MODE TRANSITION =====
// Smooth Farbübergang beim Theme Wechsel
(function initThemeTransition() {
  const root = document.documentElement;
  const originalTransition = root.style.transition;
  
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'data-mode') {
        // Add transition für smooth color change
        root.style.transition = 'background-color 0.3s ease, color 0.3s ease';
        
        setTimeout(() => {
          root.style.transition = originalTransition;
        }, 300);
      }
    });
  });
  
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['data-mode']
  });
})();

// ===== EXPORT für externe Nutzung =====
window.LiquidGlass = {
  animateDockIndicator: animateDockIndicator,
  triggerHaptic: (pattern = 10) => {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  }
};
