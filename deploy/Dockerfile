FROM nginxinc/nginx-unprivileged:alpine

# Build context = the REPO ROOT (deploy/docker-compose.yml sets context: ..),
# so a plain `git pull` deploy works with no file copying/rearranging.
COPY css/*.css /usr/share/nginx/html/webswr/css/
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/webswr/index.html
COPY js/*.js /usr/share/nginx/html/webswr/js/