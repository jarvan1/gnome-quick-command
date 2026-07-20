UUID := quick-command@xinming.local
BUILD_DIR := build/$(UUID)
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES := metadata.json extension.js prefs.js stylesheet.css lib schemas

.PHONY: build install uninstall clean pack test

build: clean
	mkdir -p $(BUILD_DIR)
	cp -r $(SOURCES) $(BUILD_DIR)/
	glib-compile-schemas --strict $(BUILD_DIR)/schemas

install: build
	mkdir -p $(INSTALL_DIR)
	cp -r $(BUILD_DIR)/. $(INSTALL_DIR)/
	@echo "Installed $(UUID). Enable it with: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

pack:
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --extra-source=lib .

test:
	node --experimental-default-type=module tests/pinyin.test.mjs

clean:
	rm -rf build dist
