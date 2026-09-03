<?php
/**
 * Plugin Name: Shiplet
 * Plugin URI: https://shiplet.cc
 * Description: Embed Shiplet review mode directly on your WordPress site's original URLs.
 * Version: 0.1.0
 * Requires at least: 6.3
 * Requires PHP: 7.4
 * Author: Shiplet
 * License: Apache-2.0
 * License URI: https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain: shiplet
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SHIPLET_PLUGIN_VERSION', '0.1.0' );
define( 'SHIPLET_INSTALLATION_OPTION', 'shiplet_embed_installation' );
define( 'SHIPLET_CONNECT_STATE_PREFIX', 'shiplet_connect_state_' );
define( 'SHIPLET_ADMIN_NOTICE_PREFIX', 'shiplet_admin_notice_' );

add_action( 'admin_menu', 'shiplet_register_settings_page' );
add_action( 'admin_post_shiplet_begin_connect', 'shiplet_begin_connect' );
add_action( 'admin_post_shiplet_connect_callback', 'shiplet_connect_callback' );
add_action( 'admin_post_shiplet_disconnect', 'shiplet_disconnect' );
add_action( 'wp_enqueue_scripts', 'shiplet_enqueue_loader' );
add_filter( 'allowed_redirect_hosts', 'shiplet_allow_app_redirect_host' );

/**
 * Return the canonical Shiplet application URL.
 *
 * Developers may override this for a local Shiplet deployment with the
 * shiplet_app_url filter.
 *
 * @return string
 */
function shiplet_app_url() {
	$url = apply_filters( 'shiplet_app_url', 'https://shiplet.cc' );
	$url = esc_url_raw( untrailingslashit( (string) $url ) );
	$parts = wp_parse_url( $url );

	if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return 'https://shiplet.cc';
	}

	$is_local = in_array(
		strtolower( $parts['host'] ),
		array( 'localhost', '127.0.0.1', '::1' ),
		true
	);
	if ( 'https' !== strtolower( $parts['scheme'] ) && ! $is_local ) {
		return 'https://shiplet.cc';
	}

	return $url;
}

/**
 * Permit wp_safe_redirect() to return administrators to the configured Shiplet
 * deployment.
 *
 * @param string[] $hosts Existing allowed redirect hosts.
 * @return string[]
 */
function shiplet_allow_app_redirect_host( $hosts ) {
	$host = wp_parse_url( shiplet_app_url(), PHP_URL_HOST );
	if ( $host ) {
		$hosts[] = $host;
	}
	return array_values( array_unique( $hosts ) );
}

/**
 * Register the Settings > Shiplet screen.
 *
 * @return void
 */
function shiplet_register_settings_page() {
	add_options_page(
		__( 'Shiplet', 'shiplet' ),
		__( 'Shiplet', 'shiplet' ),
		'manage_options',
		'shiplet',
		'shiplet_render_settings_page'
	);
}

/**
 * Render the plugin connection screen.
 *
 * @return void
 */
function shiplet_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}

	$installation = shiplet_installation();
	$notice       = get_transient( SHIPLET_ADMIN_NOTICE_PREFIX . get_current_user_id() );
	if ( $notice ) {
		delete_transient( SHIPLET_ADMIN_NOTICE_PREFIX . get_current_user_id() );
	}
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Shiplet', 'shiplet' ); ?></h1>
		<p><?php esc_html_e( 'Review this site on its original URLs with Shiplet’s contextual feedback widget.', 'shiplet' ); ?></p>

		<?php if ( is_array( $notice ) && ! empty( $notice['message'] ) ) : ?>
			<div class="notice notice-<?php echo esc_attr( $notice['type'] ?? 'info' ); ?> is-dismissible">
				<p><?php echo esc_html( $notice['message'] ); ?></p>
			</div>
		<?php endif; ?>

		<?php if ( $installation ) : ?>
			<div class="card">
				<h2><?php esc_html_e( 'Connected', 'shiplet' ); ?></h2>
				<p>
					<?php
					printf(
						/* translators: %s is the connected Shiplet project name. */
						esc_html__( 'Project: %s', 'shiplet' ),
						esc_html( $installation['project_name'] ?? __( 'WordPress site', 'shiplet' ) )
					);
					?>
				</p>
				<p>
					<?php esc_html_e( 'Start a review session by adding this query parameter to any page:', 'shiplet' ); ?>
					<code>?shiplet-review=1</code>
				</p>
				<p>
					<a class="button button-primary" href="<?php echo esc_url( add_query_arg( 'shiplet-review', '1', home_url( '/' ) ) ); ?>">
						<?php esc_html_e( 'Open site in review mode', 'shiplet' ); ?>
					</a>
				</p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="shiplet_disconnect">
					<?php wp_nonce_field( 'shiplet_disconnect' ); ?>
					<?php submit_button( __( 'Disconnect Shiplet', 'shiplet' ), 'secondary', 'submit', false ); ?>
				</form>
			</div>
		<?php else : ?>
			<div class="card">
				<h2><?php esc_html_e( 'Connect this site', 'shiplet' ); ?></h2>
				<p><?php esc_html_e( 'You’ll sign in to Shiplet, then select an existing project or create one for this site.', 'shiplet' ); ?></p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="shiplet_begin_connect">
					<?php wp_nonce_field( 'shiplet_begin_connect' ); ?>
					<?php submit_button( __( 'Connect to Shiplet', 'shiplet' ), 'primary', 'submit', false ); ?>
				</form>
			</div>
		<?php endif; ?>
	</div>
	<?php
}

/**
 * Begin the administrator connection redirect.
 *
 * @return void
 */
function shiplet_begin_connect() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die(
			esc_html__( 'You are not allowed to connect Shiplet.', 'shiplet' ),
			'',
			array( 'response' => 403 )
		);
	}
	check_admin_referer( 'shiplet_begin_connect' );

	$state = wp_generate_password( 64, false, false );
	set_transient(
		SHIPLET_CONNECT_STATE_PREFIX . get_current_user_id(),
		hash( 'sha256', $state ),
		10 * MINUTE_IN_SECONDS
	);

	$callback_url = add_query_arg(
		'action',
		'shiplet_connect_callback',
		admin_url( 'admin-post.php' )
	);
	$connect_url  = add_query_arg(
		array(
			'site_url'   => home_url( '/' ),
			'site_name'  => get_bloginfo( 'name' ),
			'return_url' => $callback_url,
			'state'      => $state,
		),
		shiplet_app_url() . '/embed/connect'
	);

	wp_safe_redirect( $connect_url );
	exit;
}

/**
 * Validate Shiplet's callback and exchange its one-time connection code from
 * the WordPress server.
 *
 * @return void
 */
function shiplet_connect_callback() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die(
			esc_html__( 'You are not allowed to connect Shiplet.', 'shiplet' ),
			'',
			array( 'response' => 403 )
		);
	}

	$state        = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
	$expected     = get_transient( SHIPLET_CONNECT_STATE_PREFIX . get_current_user_id() );
	$provided     = hash( 'sha256', $state );
	$state_valid  = is_string( $expected ) && hash_equals( $expected, $provided );
	delete_transient( SHIPLET_CONNECT_STATE_PREFIX . get_current_user_id() );

	if ( ! $state_valid ) {
		shiplet_redirect_with_notice( 'error', __( 'Shiplet connection state did not match. Please try again.', 'shiplet' ) );
	}

	$code = isset( $_GET['shiplet_code'] ) ? sanitize_text_field( wp_unslash( $_GET['shiplet_code'] ) ) : '';
	if ( 0 !== strpos( $code, 'shiplet_embed_connect_' ) || strlen( $code ) > 512 ) {
		shiplet_redirect_with_notice( 'error', __( 'Shiplet returned an invalid connection code.', 'shiplet' ) );
	}

	$response = wp_safe_remote_post(
		shiplet_app_url() . '/api/embed/installations/exchange',
		array(
			'timeout'     => 15,
			'redirection' => 0,
			'headers'     => array( 'Content-Type' => 'application/json' ),
			'body'        => wp_json_encode(
				array(
					'code'    => $code,
					'siteUrl' => home_url( '/' ),
				)
			),
		)
	);

	if ( is_wp_error( $response ) ) {
		shiplet_redirect_with_notice( 'error', __( 'WordPress could not reach Shiplet. Please try again.', 'shiplet' ) );
	}

	$status = wp_remote_retrieve_response_code( $response );
	$data   = json_decode( wp_remote_retrieve_body( $response ), true );
	if (
		201 !== $status ||
		! is_array( $data ) ||
		empty( $data['installation']['id'] ) ||
		empty( $data['installation']['projectId'] ) ||
		empty( $data['secret'] )
	) {
		shiplet_redirect_with_notice( 'error', __( 'Shiplet could not complete the connection. Please start again.', 'shiplet' ) );
	}

	$record = array(
		'installation_id'     => sanitize_text_field( $data['installation']['id'] ),
		'project_id'          => sanitize_text_field( $data['installation']['projectId'] ),
		'project_name'        => sanitize_text_field( $data['installation']['projectName'] ?? '' ),
		'site_origin'         => esc_url_raw( $data['installation']['siteOrigin'] ?? '' ),
		'installation_secret' => sanitize_text_field( $data['secret'] ),
		'connected_on'        => gmdate( 'c' ),
	);

	if ( false === get_option( SHIPLET_INSTALLATION_OPTION, false ) ) {
		add_option( SHIPLET_INSTALLATION_OPTION, $record, '', false );
	} else {
		update_option( SHIPLET_INSTALLATION_OPTION, $record, false );
	}

	shiplet_redirect_with_notice( 'success', __( 'This WordPress site is connected to Shiplet.', 'shiplet' ) );
}

/**
 * Revoke the site-scoped installation and remove the local record.
 *
 * @return void
 */
function shiplet_disconnect() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die(
			esc_html__( 'You are not allowed to disconnect Shiplet.', 'shiplet' ),
			'',
			array( 'response' => 403 )
		);
	}
	check_admin_referer( 'shiplet_disconnect' );

	$installation = shiplet_installation();
	if ( ! $installation ) {
		shiplet_redirect_with_notice( 'info', __( 'Shiplet is already disconnected.', 'shiplet' ) );
	}

	$endpoint = sprintf(
		'%s/api/embed/installations/%s',
		shiplet_app_url(),
		rawurlencode( $installation['installation_id'] )
	);
	$response = wp_safe_remote_request(
		$endpoint,
		array(
			'method'      => 'DELETE',
			'timeout'     => 15,
			'redirection' => 0,
			'headers'     => array(
				'Authorization' => 'Bearer ' . $installation['installation_secret'],
			),
		)
	);

	if ( is_wp_error( $response ) ) {
		shiplet_redirect_with_notice( 'error', __( 'WordPress could not reach Shiplet, so the connection was kept for retrying.', 'shiplet' ) );
	}
	$status = wp_remote_retrieve_response_code( $response );
	if ( ! in_array( $status, array( 200, 404, 410 ), true ) ) {
		shiplet_redirect_with_notice( 'error', __( 'Shiplet could not revoke this installation. The local connection was kept.', 'shiplet' ) );
	}

	delete_option( SHIPLET_INSTALLATION_OPTION );
	shiplet_redirect_with_notice( 'success', __( 'Shiplet was disconnected from this WordPress site.', 'shiplet' ) );
}

/**
 * Enqueue only the local activation detector. It downloads Shiplet's remote
 * embed bootstrap only after review mode is activated in this tab.
 *
 * @return void
 */
function shiplet_enqueue_loader() {
	if ( is_admin() ) {
		return;
	}
	$installation = shiplet_installation();
	if ( ! $installation ) {
		return;
	}

	wp_enqueue_script(
		'shiplet-loader',
		plugins_url( 'assets/shiplet-loader.js', __FILE__ ),
		array(),
		SHIPLET_PLUGIN_VERSION,
		array(
			'in_footer' => true,
			'strategy'  => 'defer',
		)
	);
	wp_localize_script(
		'shiplet-loader',
		'ShipletWordPress',
		array(
			'installationId' => $installation['installation_id'],
			'appUrl'         => shiplet_app_url(),
		)
	);
}

/**
 * Return a validated local installation record.
 *
 * @return array<string,string>|null
 */
function shiplet_installation() {
	$value = get_option( SHIPLET_INSTALLATION_OPTION );
	if (
		! is_array( $value ) ||
		empty( $value['installation_id'] ) ||
		empty( $value['installation_secret'] )
	) {
		return null;
	}
	return $value;
}

/**
 * Persist a one-request settings notice and return to the plugin screen.
 *
 * @param string $type Notice type.
 * @param string $message Notice message.
 * @return void
 */
function shiplet_redirect_with_notice( $type, $message ) {
	set_transient(
		SHIPLET_ADMIN_NOTICE_PREFIX . get_current_user_id(),
		array(
			'type'    => sanitize_key( $type ),
			'message' => sanitize_text_field( $message ),
		),
		MINUTE_IN_SECONDS
	);
	wp_safe_redirect( admin_url( 'options-general.php?page=shiplet' ) );
	exit;
}
