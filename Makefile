UUID := quick-command@xinming.dev
GETTEXT_DOMAIN := quick-command
BUILD_DIR := build/$(UUID)
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES := metadata.json extension.js prefs.js stylesheet.css lib schemas
PO_FILES := $(wildcard po/*.po)

.PHONY: build install uninstall clean pack deb test

build: clean
	mkdir -p $(BUILD_DIR)
	cp -r $(SOURCES) $(BUILD_DIR)/
	glib-compile-schemas --strict $(BUILD_DIR)/schemas
	@for po_file in $(PO_FILES); do \
		locale_name=$$(basename "$${po_file}" .po); \
		locale_dir="$(BUILD_DIR)/locale/$${locale_name}/LC_MESSAGES"; \
		mkdir -p "$${locale_dir}"; \
		msgfmt --check --output-file="$${locale_dir}/$(GETTEXT_DOMAIN).mo" "$${po_file}"; \
	done

install: build
	mkdir -p $(INSTALL_DIR)
	cp -r $(BUILD_DIR)/. $(INSTALL_DIR)/
	@echo "Installed $(UUID). Enable it with: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

pack: build
	mkdir -p dist
	cd $(BUILD_DIR) && gnome-extensions pack --force \
		--out-dir=$(abspath dist) --extra-source=lib --extra-source=locale .

deb:
	./packaging/build-deb.sh

test:
	node --experimental-default-type=module tests/pinyin.test.mjs

clean:
	rm -rf build dist
