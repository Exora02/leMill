{ pkgs, lib, config, inputs, ... }:

{
  # Set up Node.js for the VS Code extension
  languages.javascript.enable = true;
  languages.javascript.package = pkgs.nodejs_20;
  languages.typescript.enable = true;

  packages = [
    pkgs.nodejs_20
    pkgs.typescript
    pkgs.git
  ];

  # Optional: Define processes that you might want to run in the background
  processes.watch.exec = "cd vscode-mobile-agent && npm run watch";

  enterShell = ''
    echo "Welcome to the leMill dev environment!"
    node --version
    npm --version
    
    # Auto-install dependencies if node_modules is missing
    if [ ! -d "vscode-mobile-agent/node_modules" ]; then
      echo "Installing Node dependencies..."
      cd vscode-mobile-agent && npm install && cd ..
    fi
  '';

  enterTest = ''
    echo "Checking dependencies..."
    cd vscode-mobile-agent
    npm run compile
  '';
}
